const assert = require('node:assert/strict');
const path = require('node:path');
const {mixState} = require('./browser-onboarding.cjs');

async function loopState(frame, probe = '__qa') {
  return frame.evaluate(name => {
    const e = window[name].engine;
    return {start: Number.isFinite(e.loopStartSeconds) ? e.tickAtSeconds(e.loopStartSeconds) : null,
      end: Number.isFinite(e.loopEndSeconds) ? e.tickAtSeconds(e.loopEndSeconds) : null,
      tick: e.tickAtSeconds(e.currentSeconds()), playing: e.playing,
      labels: ['loopStart','loopEnd'].map(id => document.getElementById(id).textContent)};
  }, probe);
}

async function assertLoop(frame, start, end, probe = '__qa') {
  const state = await loopState(frame, probe);
  assert.ok(Math.abs(state.start - start) < .001, JSON.stringify({state, start}));
  assert.ok(Math.abs(state.end - end) < .001, JSON.stringify({state, end}));
  return state;
}

async function checkLoopPlayback(frame, probe = '__qa') {
  await frame.evaluate(name => {
    const e = window[name].engine;
    e.seek(e.loopEndSeconds - .15);
  }, probe);
  await frame.locator('#playPause').click();
  await frame.waitForFunction(name => window[name].engine.playing, probe);
  await frame.waitForFunction(name => {
    const e = window[name].engine, current = e.currentSeconds();
    return e.playing && current >= e.loopStartSeconds && current < e.loopStartSeconds + .5;
  }, probe, {timeout: 5000});
  await frame.locator('#playPause').click();
  assert.equal((await loopState(frame, probe)).playing, false);
}

async function holdClearLoop(frame, page, mobile) {
  if (await frame.locator('#settingsToggle').getAttribute('aria-expanded') !== 'true') await frame.locator('#settingsToggle').click();
  const box = await frame.locator('#loopEnd').boundingBox(), x = box.x + box.width/2, y = box.y + box.height/2;
  if (mobile) {
    const session = await page.context().newCDPSession(page);
    try {
      await session.send('Input.dispatchTouchEvent', {type:'touchStart', touchPoints:[{x,y}]});
      await page.waitForTimeout(750);
      await session.send('Input.dispatchTouchEvent', {type:'touchEnd', touchPoints:[]});
    } finally { await session.detach(); }
  } else {
    await page.mouse.move(x,y); await page.mouse.down();
    await page.waitForTimeout(750); await page.mouse.up();
  }
  await frame.waitForFunction(() => document.getElementById('loopEnd').textContent === 'End');
}

async function checkLoopLinks(page, origin, settled, {mobile, output}) {
  const before = await mixState(page);
  const chosen = await page.locator('#practicePart').getAttribute('data-value');
  await page.goto(`${origin}?loop=2.1.0-3.1.0`);
  await settled();
  await page.waitForFunction(() => document.getElementById('loopStart').textContent === '2');
  const seq = await page.evaluate(() => JSON.parse(document.getElementById('playback-data').textContent));
  const start = seq.measures[1][0], end = seq.measures[2][0];
  const arrival = await assertLoop(page, start, end);
  assert.deepEqual(arrival.labels, ['2','2']);
  assert.equal(arrival.playing, false);
  assert.ok(Math.abs(arrival.tick - start) < .001, JSON.stringify({arrival,start}));
  assert.equal(page.url(), origin);
  assert.deepEqual(await mixState(page), before);
  assert.equal(await page.locator('#practicePart').getAttribute('data-value'), chosen);
  await checkLoopPlayback(page);
  await page.reload(); await settled();
  await assertLoop(page, start, end);
  await page.evaluate(() => { location.hash = 'loop=2.2.75-3.1.5'; });
  await page.waitForFunction(() => document.getElementById('loopStart').textContent === '2.2.75');
  const exactStart = start + seq.division * 1.75, exactEnd = end + seq.division * .5;
  await assertLoop(page, exactStart, exactEnd);
  await page.reload(); await settled();
  await assertLoop(page, exactStart, exactEnd);
  await page.evaluate(() => { location.hash = 'loop=3-1'; });
  await page.waitForFunction(() => document.getElementById('toastMessage').textContent.includes('loop is unchanged'));
  await assertLoop(page, exactStart, exactEnd);

  // Exact boundaries must agree with repeat glyphs, not just audio scheduling.
  await page.evaluate(() => {
    const state = __qa.pitchbar.captureSettingsState();
    state.scoreView = 'bars'; state.flow = 'wrap'; state.horizontal = 100;
    __qa.pitchbar.applySettingsState(state);
  });
  await page.waitForFunction(() => document.querySelectorAll('#barScore .bar-repeat-sign').length === 2);
  const offsets = await page.evaluate(({start,end}) => __qa.pitchbar.systems.flatMap(s => {
    const x = tick => s.leftPad + (tick - s.startTick) / (s.endTick - s.startTick) * s.plotWidth;
    return [...s.svg.querySelectorAll('.bar-repeat-sign')].map(sign => {
      const rect = sign.querySelector('rect');
      const left = Number(rect.getAttribute('x')), width = Number(rect.getAttribute('width'));
      return Math.min(Math.abs(left - (x(start) + 1)), Math.abs(left + width - (x(end) - 1)));
    });
  }), {start:exactStart, end:exactEnd});
  assert.equal(offsets.length,2);
  assert.ok(offsets.every(v => v < .001), JSON.stringify(offsets));
  if (await page.locator('#settingsToggle').getAttribute('aria-expanded') !== 'true') await page.locator('#settingsToggle').click();
  await page.evaluate(() => window.scrollTo({top:0,behavior:'instant'}));
  const fit = await page.locator('.loop-point').evaluateAll(nodes => nodes.every(node => node.scrollWidth <= node.clientWidth));
  assert.equal(fit,true,'fractional labels fit the existing desktop/phone grid');
  await page.screenshot({path:path.join(output, `loop-link-${mobile ? 'mobile' : 'desktop'}.png`)});
  await holdClearLoop(page,page,mobile);
  assert.equal((await loopState(page)).end,null);
  await page.reload(); await settled();
  assert.equal((await loopState(page)).end,null,'clearing survives a refresh of the consumed link');
  await page.evaluate(() => { location.hash = 'loop=2-4'; });
  await page.waitForFunction(() => document.getElementById('loopEnd').textContent === '3');
  await assertLoop(page, start, seq.measures[3][0]);
  return {wholeMeasures:true, exactBeats:true, realPlaybackWrap:true, saved:true, invalid:true,
    mixPreserved:true, holdClear:true, repeatGeometry:offsets, labelsFit:fit};
}

module.exports = {loopState, assertLoop, checkLoopPlayback, holdClearLoop, checkLoopLinks};
