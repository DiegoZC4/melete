const assert = require('node:assert/strict');
const {withMixerSignal} = require('./browser-mixer-signal.cjs');

async function checkVolumeDrag(surface, page, mobile, probe, screenshot) {
  const controls = surface.locator('#mixer [data-volume-index]');
  const count = await controls.count();
  const values = () => controls.evaluateAll(nodes => nodes.map(node => Number(node.dataset.value)));
  const original = await surface.evaluate(probe => window[probe].pitchbar.captureSettingsState(), probe);
  const setVolumes = volumes => surface.evaluate(({probe, volumes}) => {
    const api = window[probe].pitchbar, state = api.captureSettingsState();
    state.volumes = volumes;
    api.applySettingsState(state);
  }, {probe, volumes});
  const otherSettings = () => surface.evaluate(probe => {
    const state = window[probe].pitchbar.captureSettingsState();
    return {see: state.visible, hear: state.audible, pans: state.pans, part: state.practicePart};
  }, probe);
  const before = await otherSettings();
  await surface.evaluate(() => { window.__volumeScore = document.querySelector('#score svg'); });
  const high = Array.from({length: count}, (_, i) => [190, 175, 155, 200][i % 4]);
  const low = Array.from({length: count}, (_, i) => [45, 25, 10, 0][i % 4]);
  const clamp = value => Math.max(0, Math.min(200, value));
  const gestures = [];
  try {
    for (const start of [high, low]) {
      await setVolumes(start);
      assert.deepEqual(await values(), start, 'settings restoration preserves levels above 150%');
      const label = surface.locator('[data-mixer-row="vol"]');
      await label.scrollIntoViewIfNeeded();
      const box = await label.boundingBox(), x = box.x + box.width / 2, y = box.y + box.height / 2;
      const session = mobile ? await page.context().newCDPSession(page) : null;
      try {
        if (session) await session.send('Input.dispatchTouchEvent', {type: 'touchStart', touchPoints: [{x, y}]});
        else { await page.mouse.move(x, y); await page.mouse.down(); }
        const direction = start === high ? -1 : 1;
        // The same uninterrupted gesture crosses every limit, then retraces it.
        for (const distance of [8, 24, 48, 64, 40, 16, 0]) {
          const dy = direction * distance;
          if (session) await session.send('Input.dispatchTouchEvent', {type: 'touchMove', touchPoints: [{x, y: y + dy}]});
          else await page.mouse.move(x, y + dy);
          const expected = start.map(value => clamp(value - dy / 4 * 5));
          await surface.waitForFunction(expected => JSON.stringify([...document.querySelectorAll('[data-volume-index]')]
            .map(node => Number(node.dataset.value))) === JSON.stringify(expected), expected);
          assert.deepEqual(await values(), expected, `group drag at ${dy}px remembers individual limits`);
        }
      } finally {
        if (session) {
          await session.send('Input.dispatchTouchEvent', {type: 'touchEnd', touchPoints: []});
          await session.detach();
        } else await page.mouse.up();
      }
      assert.deepEqual(await values(), start, 'returning to the start restores the original balance');
      gestures.push({start, restored: await values()});
    }
    await controls.nth(0).press('End');
    assert.equal(await controls.nth(0).getAttribute('data-value'), '200');
    assert.equal(await controls.nth(0).getAttribute('aria-valuemax'), '200');
    await withMixerSignal(surface, probe, () => surface.waitForFunction(probe =>
      Math.abs(window[probe].engine.trackStrips[0].gain.gain.value - 2) < .01, probe));
    await controls.nth(0).press('ArrowDown');
    assert.equal(await controls.nth(0).getAttribute('data-value'), '195');
    await surface.locator('[data-mixer-row="vol"]').press('ArrowUp');
    assert.equal(await controls.nth(0).getAttribute('data-value'), '200');
    await setVolumes(high);
    const geometry = await controls.evaluateAll(nodes => nodes.map(node => ({
      text: node.textContent, width: node.clientWidth, scrollWidth: node.scrollWidth,
    })));
    assert.ok(geometry.every(node => node.scrollWidth <= node.width + 1), JSON.stringify(geometry));
    if (screenshot) await page.screenshot({path: screenshot});
    assert.deepEqual(await otherSettings(), before, 'volume edits leave the other mixer settings alone');
    assert.equal(await surface.evaluate(() => __volumeScore === document.querySelector('#score svg')), true,
      'volume edits do not redraw notation');
    return {parts: count, pointer: mobile ? 'touch' : 'mouse', ceiling: 200, gestures, audioGain: 2, geometry};
  } finally {
    await surface.evaluate(({probe, original}) => window[probe].pitchbar.applySettingsState(original), {probe, original});
  }
}

async function checkBoostedAudio(surface, probe) {
  const report = await surface.evaluate(async probe => {
    const data = JSON.parse(document.getElementById('playback-data').textContent);
    const Player = window[probe].engine.constructor, count = data.parts.length;
    const results = [];
    for (const percent of [100, 200]) {
      const player = new Player({...data, division: 960, endTick: 1920, tempos: [[0, 60]],
        measures: [[0, 1920, 2, 4]], legato: [],
        notes: Array.from({length: count}, (_, i) => [i, 0, 1440, 60, 127])});
      const context = new OfflineAudioContext(2, 48000 * 2, 48000);
      const Audio = window.AudioContext;
      try {
        // Exercise the real compressor/limiter chain without speaker output.
        window.AudioContext = function() { return context; };
        player.ensureAudio();
      } finally { window.AudioContext = Audio; }
      player.updateMix(new Set(Array.from({length: count}, (_, i) => i)), Array(count).fill(percent), Array(count).fill(0), true);
      for (const note of player.notes) player.scheduleNote(note, 0, .028);
      const buffer = await context.startRendering();
      const gains = player.trackStrips.map(strip => strip.gain.gain.value);
      let peak = 0, sum = 0;
      for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
        for (const sample of buffer.getChannelData(channel)) {
          peak = Math.max(peak, Math.abs(sample)); sum += sample * sample;
        }
      }
      results.push({percent, gains, peak, rms: Math.sqrt(sum / (buffer.length * buffer.numberOfChannels))});
    }
    return results;
  }, probe);
  for (const sample of report) {
    assert.ok(sample.gains.every(gain => gain === sample.percent / 100), JSON.stringify(sample));
    assert.ok(Number.isFinite(sample.peak) && sample.peak > .001 && sample.peak < 1, JSON.stringify(sample));
  }
  assert.ok(report[1].rms > report[0].rms, '200% produces a real boost through the output protection');
  return report;
}

module.exports = {checkVolumeDrag, checkBoostedAudio};
