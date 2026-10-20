const assert = require('node:assert/strict');
const path = require('node:path');

// Instrument only the test HTML, never the distributed player.
const pitchbarProbe = `pitchbar: {
  captureSettingsState, applySettingsState, shortestPitchBarNoteTicks,
  get unit() { return pitchBarUnitTicks; }, get systems() { return barSystems; },
  get sequence() { return sequence; }
}`;

async function checkPitchbarSpacing(frame, page, {probe = '__qa', unit = 480, output, label} = {}) {
  if (await frame.locator('#partChooser').isVisible()) await frame.locator('#partChooserDismiss').click();
  const initial = await frame.evaluate(name => ({state: window[name].pitchbar.captureSettingsState(),
    playing: window[name].engine.playing, seconds: window[name].engine.currentSeconds()}), probe);
  if (initial.playing) await frame.locator('#playPause').click();
  const results = [];
  try {
    const written = await frame.evaluate(name => {
      const shortest = window[name].pitchbar.shortestPitchBarNoteTicks;
      const xml = `<score-partwise><part><measure><attributes><divisions>4</divisions></attributes>
        <note><duration>2</duration></note><note><grace/><duration>0.01</duration></note>
        <note><rest/><duration>0.01</duration></note></measure>
        <measure><attributes><divisions>12</divisions></attributes><note><duration>4</duration></note></measure>
        </part><part><measure><attributes><divisions>8</divisions></attributes>
        <note><duration>2</duration></note></measure></part></score-partwise>`;
      const oneNote = (divisions, duration) => `<score-partwise><part><measure><attributes><divisions>${divisions}</divisions>
        </attributes><note><duration>${duration}</duration></note></measure></part></score-partwise>`;
      return {written: shortest(xml, {division: 960, notes: [[0, 0, 1]]}),
        dotted: shortest(oneNote(4, 3), {division: 960}),
        triplet: shortest(oneNote(12, 4), {division: 960}),
        fallback: shortest('<score-partwise/>', {division: 960, notes: [[0, 0, 0], [0, 0, 120]]}),
        empty: shortest('', {division: 960, notes: []})};
    }, probe);
    assert.deepEqual(written, {written: 240, dotted: 720, triplet: 320, fallback: 120, empty: 960},
      'normalize changing divisions across all parts; exclude rests/graces and ignore MIDI articulation');
    await frame.evaluate(name => {
      const p = window[name].pitchbar, state = p.captureSettingsState();
      state.scoreView = 'bars'; state.flow = 'wrap'; state.lyrics = 'full';
      state.practicePart = state.visible.length - 1;
      state.visible = state.visible.map((_, i) => i === state.practicePart);
      p.applySettingsState(state);
    }, probe);
    for (const percent of [5, 100, 200, 300, 400]) {
      if (percent === 400) await frame.locator('#horizontalScale').press('End');
      else await frame.evaluate(({name, percent}) => {
        const p = window[name].pitchbar, state = p.captureSettingsState();
        state.horizontal = percent; p.applySettingsState(state);
      }, {name: probe, percent});
      await frame.waitForFunction(({name, percent}) => {
        const p = window[name].pitchbar, system = p.systems[0];
        return !document.getElementById('barScore').hidden && system
          && Math.abs(system.plotWidth / (system.endTick - system.startTick) * p.unit - 16 * percent / 100) < 1e-8;
      }, {name: probe, percent});
      const metrics = await frame.evaluate(name => {
        const p = window[name].pitchbar, surface = document.getElementById('barScore');
        const gaps = [];
        for (const s of p.systems) {
          const lanes = new Map();
          for (const text of s.svg.querySelectorAll('.bar-lyric-text')) {
            const y = text.getAttribute('y'), bounds = text.getBBox();
            if (!lanes.has(y)) lanes.set(y, []);
            lanes.get(y).push(bounds);
          }
          for (const line of lanes.values()) {
            line.sort((a, b) => a.x - b.x);
            for (let i = 1; i < line.length; i++) gaps.push(line[i].x - line[i-1].x - line[i-1].width);
          }
        }
        return {unit: p.unit, rows: p.systems.length,
          widths: p.systems.map(s => s.plotWidth),
          unitWidths: p.systems.map(s => s.plotWidth / (s.endTick-s.startTick) * p.unit * s.svg.getScreenCTM().a),
          maxLyricLanes: Math.max(0, ...p.systems.map(s => new Set([...s.svg.querySelectorAll('.bar-lyric-text')]
            .map(t => t.getAttribute('y'))).size)),
          smallestGap: gaps.length ? Math.min(...gaps) : null,
          overflows: surface.classList.contains('has-horizontal-overflow'),
          pageOverflow: document.documentElement.scrollWidth - innerWidth};
      }, probe);
      assert.equal(metrics.unit, unit);
      for (const width of metrics.unitWidths) assert.ok(Math.abs(width - 16 * percent / 100) < .05,
        `actual SVG pixels must honor ${percent}%: ${width}`);
      assert.ok(metrics.smallestGap === null || metrics.smallestGap >= -.05, JSON.stringify(metrics));
      assert.ok(metrics.pageOverflow <= 1, 'wide measures scroll inside the score, not the whole page');
      if (percent === 400 && metrics.overflows) {
        const reach = await frame.evaluate(name => {
          const p = window[name].pitchbar, surface = document.getElementById('barScore');
          surface.scrollLeft = surface.scrollWidth;
          const widest = p.systems.reduce((a,b) => a.plotWidth > b.plotWidth ? a : b);
          const matrix = widest.svg.getScreenCTM();
          return {scroll: surface.scrollLeft, edge: matrix.e + (widest.leftPad + widest.plotWidth) * matrix.a,
            right: surface.getBoundingClientRect().right, touch: getComputedStyle(surface).touchAction};
        }, probe);
        assert.ok(reach.scroll > 0);
        assert.ok(reach.edge <= reach.right + 1, 'rightmost barline can be reached');
        assert.match(reach.touch, /pan-x/);
        await frame.locator('#barScore').evaluate(node => { node.scrollLeft = 0; });
      }
      if (output && percent === 200) {
        const row = await frame.evaluate(name => {
          const p = window[name].pitchbar, measure = p.sequence.measures[Math.min(14, p.sequence.measures.length - 1)];
          return Math.max(0, p.systems.findIndex(s => s.startTick <= measure[0] && s.endTick > measure[0]));
        }, probe);
        await frame.locator('.bar-system').nth(row).scrollIntoViewIfNeeded();
        await page.screenshot({path: path.join(output, `pitchbar-${label}-200.png`)});
      }
      results.push({percent, ...metrics});
    }
    await frame.locator('#flowToggle').click();
    await frame.waitForFunction(name => window[name].pitchbar.systems.length === 1
      && document.getElementById('barScore').classList.contains('is-continuous'), probe);
    const continuous = await frame.evaluate(name => {
      const p = window[name].pitchbar, s = p.systems[0];
      return s.plotWidth / (s.endTick-s.startTick) * p.unit * s.svg.getScreenCTM().a;
    }, probe);
    assert.ok(Math.abs(continuous - 64) < .05, 'continuous mode uses the same scale');
  } finally {
    await frame.evaluate(({name, initial}) => {
      window[name].pitchbar.applySettingsState(initial.state);
      window[name].api.tickPosition = window[name].engine.tickAtSeconds(initial.seconds);
      document.getElementById('barScore').scrollLeft = 0;
    }, {name: probe, initial});
    await frame.waitForFunction(() => !document.getElementById('score').hidden && document.querySelector('#score svg'));
    if (initial.playing) await frame.locator('#playPause').click();
  }
  return results;
}

module.exports = {pitchbarProbe, checkPitchbarSpacing};
