// Browser checks for a singer's first minutes: the part chooser, part links,
// the hold tips, touch-sized mixer rows and section names while scrubbing.
// `surface` is the player's page or frame; `page` owns the viewport and input.
const assert = require('node:assert/strict');

const TIP_STORE = 'choir-practice:shortcut-tips:v1';

function mixState(surface) {
  return surface.evaluate(() => ({
    see: [...document.querySelectorAll('#mixer [data-visible-index]')].map(node => node.getAttribute('aria-pressed')),
    hear: [...document.querySelectorAll('#mixer [data-audio-index]')].map(node => node.getAttribute('aria-pressed')),
    volumes: [...document.querySelectorAll('#mixer [data-volume-index]')].map(node => node.dataset.value),
    pans: [...document.querySelectorAll('#mixer [data-pan-index]')].map(node => node.dataset.value),
  }));
}

const practicePart = surface => surface.evaluate(() => document.getElementById('practicePart').dataset.value);
const learnedTips = surface => surface.evaluate(key => JSON.parse(localStorage.getItem(key) || '[]'), TIP_STORE);
const chooserAnswer = surface => surface.evaluate(() =>
  Object.entries(localStorage).find(([key]) => key.endsWith(':part-chooser'))?.[1] ?? null);

async function toastText(surface) {
  await surface.waitForFunction(() => document.getElementById('toast').classList.contains('is-visible'));
  return surface.locator('#toastMessage').textContent();
}

async function touch(page, points) {
  const session = await page.context().newCDPSession(page);
  try {
    for (const [type, point, pause = 16] of points) {
      await session.send('Input.dispatchTouchEvent', {type, touchPoints: point ? [point] : []});
      await page.waitForTimeout(pause);
    }
  } finally { await session.detach(); }
}

async function openSettings(surface) {
  if (await surface.locator('#settingsToggle').getAttribute('aria-expanded') !== 'true')
    await surface.locator('#settingsToggle').click();
}

// A fresh visit asks once; answering says who is singing and nothing else.
async function checkFirstVisit(surface, page, {mobile, names, choose = 1}) {
  const chooser = surface.locator('#partChooser');
  await chooser.waitFor({state: 'visible'});
  assert.deepEqual(await surface.locator('#partChooserOptions button').allTextContents(), names);
  assert.equal(await chooser.getAttribute('role'), 'dialog');
  assert.equal(await practicePart(surface), '', 'no part is guessed before the singer answers');
  const box = await chooser.boundingBox(), viewport = page.viewportSize();
  const header = await surface.locator('.transport-primary').boundingBox();
  assert.ok(box.x >= 0 && box.x + box.width <= viewport.width && box.y + box.height <= viewport.height, JSON.stringify(box));
  assert.ok(box.y >= header.y + header.height, 'the card leaves the transport usable');
  for (const option of await surface.locator('#partChooserOptions button').all()) {
    const target = await option.boundingBox();
    assert.ok(target.height >= 36 && target.width >= 44, `chooser targets fit a finger: ${JSON.stringify(target)}`);
  }
  const before = await mixState(surface);
  const option = surface.locator('#partChooserOptions button').nth(choose);
  if (mobile) await option.tap(); else await option.click();
  await chooser.waitFor({state: 'hidden'});
  assert.equal(await practicePart(surface), String(choose));
  assert.deepEqual(await mixState(surface), before, 'choosing a part changes no See, Hear, Vol or Pan setting');
  assert.equal(await chooserAnswer(surface), 'chosen');
  assert.equal(await toastText(surface), `Practising ${names[choose]}`);
  let tip = null;
  if (await surface.locator('#mixer').isVisible()) {
    // Choosing is the moment to learn that holding the part's number brings it forward.
    await surface.locator('#shortcutTip').waitFor({state: 'visible'});
    tip = await surface.locator('#shortcutTipMessage').textContent();
    assert.equal(tip, `Press and hold ${names[choose]}’s volume to emphasize ${names[choose]} (others 20%). `
      + `Hold again to reduce ${names[choose]} to 20%; a third time sets all voices to 100%.`);
    assert.equal(await surface.locator(`[data-volume-index="${choose}"]`).evaluate(node =>
      node.classList.contains('is-shortcut-tip-target')), true);
    const settingsOpen = await surface.locator('#settingsToggle').getAttribute('aria-expanded');
    await page.keyboard.press('Escape');
    await surface.locator('#shortcutTip').waitFor({state: 'hidden'});
    assert.equal(await surface.locator('#settingsToggle').getAttribute('aria-expanded'), settingsOpen,
      'Escape dismisses only the tip');
    assert.ok((await learnedTips(surface)).includes('vol-hold'));
  } else {
    // With the mixer out of sight the tip waits for a later moment.
    await page.waitForTimeout(1200);
    assert.equal(await surface.locator('#shortcutTip').isVisible(), false);
    assert.ok(!(await learnedTips(surface)).includes('vol-hold'));
  }
  return {options: names.length, chosen: names[choose], tip: Boolean(tip)};
}

// After a finished touch drag, the hold that would have done it is offered,
// next to the control and clear of it; a touch elsewhere dismisses it.
async function checkTouchVolumeTip(surface, page, name, index = 0) {
  await openSettings(surface);
  const cell = surface.locator(`[data-volume-index="${index}"]`);
  await cell.scrollIntoViewIfNeeded();
  const start = await cell.getAttribute('data-value');
  const drag = async (dy, points = 5) => {
    const box = await cell.boundingBox(), x = box.x + box.width / 2, y = box.y + box.height / 2;
    await touch(page, [['touchStart', {x, y}],
      ...Array.from({length: points}, (_, step) => ['touchMove', {x, y: y + dy * (step + 1) / points}]), ['touchEnd']]);
  };
  await drag(-20);
  assert.notEqual(await cell.getAttribute('data-value'), start, 'the drag changed the volume');
  await surface.locator('#shortcutTip').waitFor({state: 'visible'});
  assert.equal(await surface.locator('#shortcutTipMessage').textContent(),
    `Press and hold ${name}’s volume to emphasize ${name} (others 20%). `
    + `Hold again to reduce ${name} to 20%; a third time sets all voices to 100%.`);
  const [tip, target] = [await surface.locator('#shortcutTip').boundingBox(), await cell.boundingBox()];
  const viewport = page.viewportSize();
  assert.ok(tip.x >= 0 && tip.x + tip.width <= viewport.width && tip.y >= 0 && tip.y + tip.height <= viewport.height);
  assert.ok(tip.y >= target.y + target.height || tip.y + tip.height <= target.y, 'the tip never covers its control');
  await drag(20);
  await surface.locator('#shortcutTip').waitFor({state: 'hidden'});
  assert.equal(await cell.getAttribute('data-value'), start, 'reversing the drag restores the volume');
  assert.ok((await learnedTips(surface)).includes('vol-hold'));
  return {tip: 'vol-hold', input: 'touch'};
}

// Standalone links: #part= or ?part=, consumed once, never touching the mix.
async function checkPartLinks(page, origin, settled, {names}) {
  // Leave first, so a new hash is a fresh arrival rather than a hashchange.
  const go = async address => { await page.goto('about:blank'); await page.goto(address); await settled(); };
  const before = await mixState(page);
  const current = Number(await practicePart(page));
  const other = (current + 1) % names.length;
  await go(`${origin}#part=${encodeURIComponent(names[other].toLowerCase())}`);
  assert.equal(await practicePart(page), String(other));
  assert.equal(page.url(), origin, 'the followed link leaves the address');
  assert.equal(await toastText(page), `Practising ${names[other]} from the link`);
  assert.equal(await page.locator('#partChooser').isVisible(), false);
  assert.deepEqual(await mixState(page), before, 'a link changes the part, not the saved mix');
  await page.locator('#toastUndo').click();
  assert.equal(await practicePart(page), String(current), 'Undo returns to the singer’s own part');
  await page.evaluate(name => { location.hash = `part=${name.slice(0, 3)}`; }, names[other]);
  await page.waitForFunction(other => document.getElementById('practicePart').dataset.value === String(other), other);
  assert.equal(page.url(), origin);
  await page.evaluate(() => { location.hash = 'part=Mezzo'; });
  await page.waitForFunction(() => document.getElementById('toastMessage').textContent.includes('Mezzo'));
  assert.equal(await page.locator('#toastMessage').textContent(),
    `This song has no part called “Mezzo”; still practising ${names[other]}`);
  assert.equal(await practicePart(page), String(other));
  await go(`${origin}?part=${encodeURIComponent(names[current])}`);
  assert.equal(await practicePart(page), String(current), 'a query works where a hash cannot be used');
  assert.equal(page.url(), origin);
  assert.deepEqual(await mixState(page), before);
  return {hash: true, query: true, hashchange: true, undo: true, unknown: true};
}

// Touch screens get finger-sized mixer rows; everything else keeps the
// compact 24px rhythm. Every control stays reachable and nothing overlaps.
async function checkTouchRows(surface, page, {mobile, landscape = true}) {
  await openSettings(surface);
  const measure = () => surface.evaluate(() => {
    const rect = node => { const r = node.getBoundingClientRect(); return {x: r.x, y: r.y, w: r.width, h: r.height}; };
    const cells = [...document.querySelectorAll('#mixer > *')].map(rect);
    const overlaps = [];
    cells.forEach((a, i) => cells.slice(i + 1).forEach((b, j) => {
      if (a.x < b.x + b.w - .5 && b.x < a.x + a.w - .5 && a.y < b.y + b.h - .5 && b.y < a.y + a.h - .5) overlaps.push([i, i + j + 1]);
    }));
    const panel = document.getElementById('settingsPanel');
    return {rows: [...new Set(cells.map(cell => Math.round(cell.h)))], overlaps,
      pager: Math.round(document.getElementById('practicePart').getBoundingClientRect().height),
      panel: {scroll: panel.scrollHeight, client: panel.clientHeight}};
  });
  const portrait = await measure();
  assert.deepEqual(portrait.rows, [mobile ? 36 : 24], JSON.stringify(portrait));
  assert.deepEqual(portrait.overlaps, []);
  assert.equal(portrait.pager, 22, 'the Practice group keeps its compact rows');
  const report = {rowHeight: portrait.rows[0], panel: portrait.panel};
  if (mobile && landscape) {
    const size = page.viewportSize();
    await page.setViewportSize({width: size.height, height: size.width});
    try {
      await page.waitForTimeout(250);
      await openSettings(surface);
      const turned = await measure();
      assert.deepEqual(turned.rows, [36]);
      assert.deepEqual(turned.overlaps, []);
      // The drawer may scroll in landscape; each control must still come into view uncovered.
      const controls = surface.locator('#mixer button, #mixer .mixer-row-label, #practicePart, #tempo, #pitchCapture');
      for (const control of await controls.all()) {
        await control.scrollIntoViewIfNeeded();
        const hit = await control.evaluate(node => {
          const r = node.getBoundingClientRect(), x = r.x + r.width / 2, y = r.y + r.height / 2;
          const top = document.elementFromPoint(x, y);
          return {reachable: node === top || node.contains(top), x, y, width: innerWidth, height: innerHeight};
        });
        assert.ok(hit.reachable && hit.x <= hit.width && hit.y <= hit.height, JSON.stringify(hit));
      }
      report.landscape = {panel: turned.panel, controls: await controls.count()};
    } finally { await page.setViewportSize(size); await page.waitForTimeout(250); }
  }
  return report;
}

// A finger scrubbing the timeline sees the section under the thumb on the rail;
// a mouse keeps the plain slider. The label goes when the gesture ends.
async function checkScrubLabel(surface, page, {mobile}) {
  const seek = await surface.locator('#seek').boundingBox();
  const rail = await surface.locator('#timelineRail').boundingBox();
  const y = seek.y + seek.height / 2;
  const sections = await surface.locator('#timelineSegments > *').evaluateAll(nodes => nodes.map(node => node.title));
  const labelAtSeek = () => surface.evaluate(() => {
    const value = Number(document.getElementById('seek').value);
    let title = '';
    for (const node of document.getElementById('timelineSegments').children)
      if (Number(node.dataset.chapterMilliseconds) <= value + 1) title = node.title;
    const label = document.getElementById('scrubLabel');
    const box = label.getBoundingClientRect();
    return {title, text: label.textContent, hidden: label.hidden, box: {x: box.x, y: box.y, w: box.width, h: box.height}};
  });
  const seen = new Set();
  if (mobile) {
    const session = await page.context().newCDPSession(page);
    try {
      await session.send('Input.dispatchTouchEvent', {type: 'touchStart', touchPoints: [{x: seek.x + 8, y}]});
      for (const fraction of [.2, .45, .7, .9]) {
        await session.send('Input.dispatchTouchEvent', {type: 'touchMove',
          touchPoints: [{x: seek.x + seek.width * fraction, y: y + 40 * fraction}]});
        await page.waitForTimeout(60);
        const state = await labelAtSeek();
        assert.equal(state.hidden, false, `the section shows while scrubbing (${fraction})`);
        assert.equal(state.text, state.title);
        assert.ok(Math.abs(state.box.y + state.box.h / 2 - (rail.y + rail.height / 2)) <= 1.5, 'the label sits on the rail');
        assert.ok(state.box.x >= 0 && state.box.x + state.box.w <= page.viewportSize().width);
        seen.add(state.text);
      }
      await session.send('Input.dispatchTouchEvent', {type: 'touchEnd', touchPoints: []});
    } finally { await session.detach(); }
    await surface.waitForFunction(() => document.getElementById('scrubLabel').hidden);
    assert.ok(seen.size >= 2, `scrubbing passed several sections: ${[...seen]}`);
    assert.ok([...seen].every(text => sections.includes(text)));
  } else {
    await page.mouse.move(seek.x + 8, y); await page.mouse.down();
    await page.mouse.move(seek.x + seek.width * .7, y, {steps: 6});
    assert.equal((await labelAtSeek()).hidden, true, 'a mouse keeps the plain slider and its titles');
    await page.mouse.up();
  }
  return {sections: sections.length, shown: [...seen]};
}

module.exports = {checkFirstVisit, checkTouchVolumeTip, checkPartLinks, checkTouchRows, checkScrubLabel, mixState};
