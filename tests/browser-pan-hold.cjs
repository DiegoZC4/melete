const assert = require('node:assert/strict');

async function checkPanHolds(surface, page, mobile, probe) {
  const pans = surface.locator('#mixer [data-pan-index]');
  const count = await pans.count();
  assert.ok(count > 1);
  const values = () => pans.evaluateAll(nodes => nodes.map(node => Number(node.dataset.value)));
  const otherSettings = () => surface.evaluate(() => ({
    hear: [...document.querySelectorAll('[data-audio-index]')].map(node => node.getAttribute('aria-pressed')),
    see: [...document.querySelectorAll('[data-visible-index]')].map(node => node.getAttribute('aria-pressed')),
    volumes: [...document.querySelectorAll('[data-volume-index]')].map(node => node.dataset.value),
    part: document.getElementById('practicePart').dataset.value,
  }));
  const before = await otherSettings(), original = await values();
  await surface.evaluate(() => { window.__panScore = document.querySelector('#score svg'); });
  const hold = async index => {
    const control = pans.nth(index);
    await control.scrollIntoViewIfNeeded();
    const box = await control.boundingBox(), x = box.x + box.width / 2, y = box.y + box.height / 2;
    if (mobile) {
      const session = await page.context().newCDPSession(page);
      try {
        await session.send('Input.dispatchTouchEvent', {type: 'touchStart', touchPoints: [{x, y}]});
        await page.waitForTimeout(680);
        await session.send('Input.dispatchTouchEvent', {type: 'touchEnd', touchPoints: []});
      } finally { await session.detach(); }
    } else {
      await page.mouse.move(x, y); await page.mouse.down();
      await page.waitForTimeout(680); await page.mouse.up();
    }
  };
  const separated = target => Array.from({length: count}, (_, index) => index === target ? 100 : -100);
  if (mobile) await pans.nth(1).tap(); else await pans.nth(1).click();
  assert.deepEqual(await values(), original, 'short press does not change pan');
  await hold(1);
  assert.deepEqual(await values(), separated(1));
  assert.match(await pans.nth(1).getAttribute('title'), /Hold to center all parts/);
  try {
    await surface.waitForFunction(({probe, values}) => window[probe].engine.trackStrips.every((strip, index) =>
      !strip.panner || Math.abs(strip.panner.pan.value - values[index] / 100) < .01), {probe, values: separated(1)});
  } catch (error) {
    const state = await surface.evaluate(probe => ({
      context: window[probe].engine.context?.state,
      time: window[probe].engine.context?.currentTime,
      pans: window[probe].engine.trackStrips.map(strip => strip.panner?.pan.value),
    }), probe);
    throw new Error(`Pan audio did not settle: ${JSON.stringify(state)}`, {cause: error});
  }
  await hold(1);
  assert.deepEqual(await values(), Array(count).fill(0), 'second hold centers everyone, not just this dial');
  await pans.nth(0).press('Shift+Enter');
  await pans.nth(count - 1).press('Shift+Enter');
  assert.deepEqual(await values(), separated(count - 1), 'holding another dial retargets separation');
  await pans.nth(count - 1).press('Shift+Enter');
  assert.deepEqual(await values(), Array(count).fill(0));
  assert.deepEqual(await otherSettings(), before, 'pan gestures leave visibility, volume, audibility and part selection unchanged');
  assert.equal(await surface.evaluate(() => __panScore === document.querySelector('#score svg')), true,
    'mix-only changes must not redraw notation');
  return {parts: count, pointer: mobile ? 'touch' : 'mouse', holds: 2, keyboard: true, audioPans: true};
}

module.exports = {checkPanHolds};
