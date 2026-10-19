const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const app = fs.readFileSync(path.join(__dirname, '../template/app.js'), 'utf8');
function source(name) {
  const start = app.indexOf(`  function ${name}(`);
  assert.ok(start >= 0, name);
  return app.slice(start, app.indexOf('\n  }', start) + 4);
}
const plain = value => JSON.parse(JSON.stringify(value));

test('restoring a collection position bypasses chapter magnets and validates the request', () => {
  const positions = [];
  const c = vm.createContext({ready:true, engine:{}, api:{set tickPosition(tick) { positions.push(tick); }},
    seekTickFor: milliseconds => milliseconds * .96,
    previewSeek() { assert.fail('restoration must not snap'); },
    snapSeekMilliseconds() { assert.fail('restoration must not snap'); }});
  vm.runInContext(source('restorePlaybackPosition'), c);
  assert.equal(c.restorePlaybackPosition(2000), true);
  assert.deepEqual(positions, [1920]);
  for (const invalid of [undefined, null, '2000', NaN, Infinity]) assert.equal(c.restorePlaybackPosition(invalid), false);
  c.ready = false;
  assert.equal(c.restorePlaybackPosition(4000), false);
  assert.deepEqual(positions, [1920]);
});

function mixFixture() {
  const c = vm.createContext({
    parts: ['S', 'A', 'T', 'B'].map(name => ({name})), practicePartIndex: 0,
    activePracticeMix: null, practiceMixPartIndex: null, practiceMixUndo: null,
    audibleTracks: new Set([0, 2, 3]), trackVolumes: [85, 70, 110, 45],
    volumeControls: [], elements: {practicePart: {focus() {}}},
    VOLUME_VALUES: Array.from({length: 31}, (_, i) => i * 5),
    nearestAllowed: (value, values) => values.reduce((a, b) => Math.abs(a - value) <= Math.abs(b - value) ? a : b),
    clamp: (v, min, max) => Math.min(max, Math.max(min, v)),
    updateMixerAppearance() {}, savePreferences() {}, showToast() {}, renderPitchTrace() {},
  });
  for (const name of ['practiceMixMatches', 'normalizePracticeMixUndo', 'cancelPracticeMixSession',
    'snapshotPracticeMix', 'restorePracticeMix', 'currentPracticeMix', 'applyPracticeMix', 'nextPartVolumeMix', 'cyclePartVolumeMix',
    'setPracticePart', 'setTrackAudible']) vm.runInContext(source(name), c);
  return c;
}

test('pan holds separate the held part, then center everyone without changing the vocal mix', () => {
  for (const count of [1, 3, 4, 8]) {
    let saved = 0, updated = 0;
    const c = mixFixture();
    c.parts = Array.from({length: count}, (_, i) => ({name: `Part ${i}`}));
    c.trackPans = c.parts.map((_, i) => i * 5);
    const before = plain(c.snapshotPracticeMix());
    c.engine = {updateMix(audible, volumes, pans) {
      assert.deepEqual([...audible], [...c.audibleTracks]);
      assert.deepEqual(plain(volumes), before.volumes);
      assert.deepEqual(plain(pans), plain(c.trackPans));
      updated++;
    }};
    c.savePreferences = () => saved++;
    c.updatePanHoldAppearance = () => {};
    const controls = [];
    c.panControls = c.parts.map((_, index) => ({setValue(value, emit) {
      assert.equal(emit, false); controls[index] = value;
    }}));
    for (const name of ['partPanIsSeparated', 'togglePartPanSeparation']) vm.runInContext(source(name), c);
    for (let target = 0; target < count; target++) {
      c.togglePartPanSeparation(target);
      assert.deepEqual(plain(c.trackPans), c.parts.map((_, i) => i === target ? 100 : -100));
      assert.deepEqual(controls, plain(c.trackPans));
      assert.equal(c.partPanIsSeparated(target), true);
      c.togglePartPanSeparation(target);
      assert.deepEqual(plain(c.trackPans), c.parts.map(() => 0));
    }
    assert.deepEqual(plain(c.snapshotPracticeMix()), before);
    assert.equal(c.practicePartIndex, 0);
    assert.equal(saved, count * 2);
    assert.equal(updated, saved);
    for (const invalid of [-1, count, null, undefined, 1.5]) c.togglePartPanSeparation(invalid);
    assert.equal(saved, count * 2);
    c.trackPans = c.parts.map((_, i) => i === 0 ? 100 : -100);
    c.togglePartPanSeparation(0);
    assert.deepEqual(plain(c.trackPans), c.parts.map(() => 0), 'manual/reloaded separation resets without preset metadata');
    if (count > 1) {
      c.togglePartPanSeparation(0);
      c.togglePartPanSeparation(1);
      assert.deepEqual(plain(c.trackPans), c.parts.map((_, i) => i === 1 ? 100 : -100));
      c.trackPans[0] = -95;
      c.togglePartPanSeparation(1);
      assert.deepEqual(plain(c.trackPans), c.parts.map((_, i) => i === 1 ? 100 : -100), 'custom mix starts with separation');
    }
  }
});

for (const mode of ['learn', 'check']) {
  test(`${mode} follows part changes and restores the original custom mix`, () => {
    const c = mixFixture(), original = plain(c.snapshotPracticeMix());
    c.applyPracticeMix(mode);
    for (const part of [1, 1, 3, 0, 2]) {
      c.setPracticePart(part);
      assert.equal(c.currentPracticeMix(), mode);
      assert.deepEqual(plain(c.trackVolumes), [0, 1, 2, 3].map(i =>
        (mode === 'learn') === (i === part) ? 100 : 20));
      assert.deepEqual(plain(c.practiceMixUndo), original);
    }
    c.applyPracticeMix(mode);
    assert.deepEqual(plain(c.snapshotPracticeMix()), original);
    assert.equal(c.currentPracticeMix(), null);
    assert.equal(c.practiceMixUndo, null);
  });
}

test('switching Learn/Check or clearing the chosen part keeps the same restore point', () => {
  const c = mixFixture(), original = plain(c.snapshotPracticeMix());
  c.applyPracticeMix('learn');
  c.setPracticePart(1);
  c.applyPracticeMix('check');
  c.setPracticePart(2);
  assert.deepEqual(plain(c.practiceMixUndo), original);
  c.setPracticePart(null);
  assert.deepEqual(plain(c.snapshotPracticeMix()), original);
  assert.equal(c.currentPracticeMix(), null);
  assert.equal(c.practicePartIndex, null);
});

test('changing practice part without a preset preserves a manual mix', () => {
  const c = mixFixture(), original = plain(c.snapshotPracticeMix());
  c.setPracticePart(2);
  assert.deepEqual(plain(c.snapshotPracticeMix()), original);
  c.applyPracticeMix('learn');
  c.setTrackAudible(1, false);
  const manual = plain(c.snapshotPracticeMix());
  c.setPracticePart(1);
  assert.deepEqual(plain(c.snapshotPracticeMix()), manual);
  c.applyPracticeMix('check');
  c.setPracticePart(3);
  c.applyPracticeMix('check');
  assert.deepEqual(plain(c.snapshotPracticeMix()), manual);
});

test('holding a volume cycles its own part without changing the practice selection', () => {
  const c = mixFixture();
  for (const practicePart of [null, 0]) {
    c.practicePartIndex = practicePart;
    c.cyclePartVolumeMix(2);
    assert.equal(c.currentPracticeMix(), 'learn');
    assert.equal(c.practiceMixPartIndex, 2);
    assert.equal(c.practicePartIndex, practicePart);
    assert.deepEqual(plain(c.trackVolumes), [20, 20, 100, 20]);
    c.cyclePartVolumeMix(2);
    assert.equal(c.currentPracticeMix(), 'check');
    assert.deepEqual(plain(c.trackVolumes), [100, 100, 20, 100]);
    c.cyclePartVolumeMix(2);
    assert.deepEqual(plain(c.trackVolumes), [100, 100, 100, 100]);
    assert.deepEqual([...c.audibleTracks], [0, 1, 2, 3]);
    assert.equal(c.currentPracticeMix(), null);
    assert.equal(c.practiceMixPartIndex, null);
    assert.equal(c.practicePartIndex, practicePart);
  }
});

test('holding another volume emphasizes that part and the third hold resets all voices', () => {
  const c = mixFixture(), original = plain(c.snapshotPracticeMix());
  c.cyclePartVolumeMix(0);
  c.cyclePartVolumeMix(0);
  c.cyclePartVolumeMix(3);
  assert.equal(c.currentPracticeMix(), 'learn');
  assert.deepEqual(plain(c.trackVolumes), [20, 20, 20, 100]);
  assert.deepEqual(plain(c.practiceMixUndo), original);
  c.cyclePartVolumeMix(3);
  c.cyclePartVolumeMix(3);
  assert.deepEqual(plain(c.trackVolumes), [100, 100, 100, 100]);
  const reset = plain(c.snapshotPracticeMix());
  for (const invalid of [-1, 99, null]) c.cyclePartVolumeMix(invalid);
  assert.deepEqual(plain(c.snapshotPracticeMix()), reset);
});

test('volume holds infer the next mode from actual levels without a preset session', () => {
  for (const count of [2, 4, 6]) for (let part = 0; part < count; part++) {
    for (const audible of [true, false]) {
      const c = mixFixture();
      c.parts = Array.from({length: count}, (_, i) => ({name: `Part ${i}`}));
      c.trackVolumes = c.parts.map((_, i) => i === part ? 100 : 20);
      c.audibleTracks = new Set(audible ? c.parts.map((_, i) => i) : []);
      assert.equal(c.nextPartVolumeMix(part), 'check');
      c.cyclePartVolumeMix(part);
      assert.deepEqual(plain(c.trackVolumes), c.parts.map((_, i) => i === part ? 20 : 100));
      assert.equal(c.audibleTracks.size, count);
      c.cancelPracticeMixSession();
      assert.equal(c.nextPartVolumeMix(part), 'normal');
      c.cyclePartVolumeMix(part);
      assert.deepEqual(plain(c.trackVolumes), c.parts.map(() => 100));
      assert.equal(c.nextPartVolumeMix(part), 'learn');
      c.cyclePartVolumeMix(part);
      assert.deepEqual(plain(c.trackVolumes), c.parts.map((_, i) => i === part ? 100 : 20));
    }
  }
});

test('any custom volume mix starts with emphasis, ignoring stale preset metadata', () => {
  for (const volumes of [[100, 100, 100, 100], [85, 70, 110, 45], [20, 20, 95, 20],
    [100, 100, 25, 100], [0, 0, 0, 0], [150, 150, 150, 150]]) {
    const c = mixFixture();
    c.applyPracticeMix('check', {partIndex: 2});
    c.trackVolumes = [...volumes];
    assert.equal(c.nextPartVolumeMix(2), 'learn');
    c.cyclePartVolumeMix(2);
    assert.deepEqual(plain(c.trackVolumes), [20, 20, 100, 20]);
  }
});

test('normal volume reset updates the controls silently and discards the old mix snapshot', () => {
  const c = mixFixture(), updates = [];
  c.volumeControls = c.parts.map((_, index) => ({setValue: (value, emit) => updates.push({index, value, emit})}));
  c.cyclePartVolumeMix(1);
  c.cyclePartVolumeMix(1);
  updates.length = 0;
  c.cyclePartVolumeMix(1);
  assert.deepEqual(updates, c.parts.map((_, index) => ({index, value: 100, emit: false})));
  assert.equal(c.practiceMixUndo, null);
  assert.equal(c.practiceMixPartIndex, null);
  assert.equal(c.activePracticeMix, null);
});

test('loop endpoints include their selected measure and preserve complete measure durations', () => {
  const classes = () => ({toggle() {}, add() {}, remove() {}});
  const element = () => ({classList: classes(), setAttribute() {}, dataset: {}, style: {}});
  let tick = 0, loop;
  const c = vm.createContext({
    sequence: {measures: [[0, 960], [960, 1440], [2400, 960]], endTick: 3360},
    loopStartMeasure: null, loopEndMeasure: null, scoreView: 'standard',
    engine: {tickAtSeconds: s => s, currentSeconds: () => tick, setLoop: (...values) => {loop = values;}},
    elements: Object.fromEntries(['loopStart', 'loopEnd', 'loopClear', 'loopControls', 'loopBand'].map(k => [k, element()])),
    clamp: (v, min, max) => Math.min(max, Math.max(min, v)), savePreferences() {}, showToast() {},
  });
  for (const name of ['measureIndexAtTick', 'currentMeasureIndex', 'updateLoopState', 'setLoopPoint', 'clearLoop']) {
    vm.runInContext(source(name), c);
  }
  c.setLoopPoint('end');
  assert.deepEqual(loop, [0, 960], 'end at the first downbeat includes m1');
  c.clearLoop();
  tick = 960;
  c.setLoopPoint('start');
  assert.deepEqual(loop, [null, null], 'a start alone does not loop');
  tick = 2400 - 1e-8;
  c.setLoopPoint('end');
  assert.equal(c.loopEndMeasure, 2);
  assert.deepEqual(loop, [960, 3360], 'm2 through the end of m3, not the start of m3');
  tick = 100;
  c.setLoopPoint('end');
  assert.equal(c.loopStartMeasure, null, 'an earlier end clears the conflicting start');
  assert.deepEqual(loop, [0, 960]);
  tick = 3360;
  c.setLoopPoint('end');
  assert.deepEqual(loop, [0, 3360], 'the very end still selects the final measure');
});

test('dense pitchbar lyrics never reuse occupied lanes; repacking stays the same size', () => {
  const c = vm.createContext({PITCH_BAR_HYPHEN_LEEWAY: 2,
    measuredSvgTextLength: (text, start, length) => length === undefined ? text.textContent.length * 8 : length * 8});
  for (const name of ['assignLyricLanes', 'relaxLyricHyphens', 'restoreSplitWordHyphens', 'packPitchBarLyrics']) {
    vm.runInContext(source(name), c);
  }
  const words = Array.from({length: 8}, (_, i) => {
    const attrs = {x: String(i * 5), y: '100'};
    return {dataset: {verse: '0'}, textContent: 'syllable',
      getAttribute: key => attrs[key], setAttribute: (key, value) => {attrs[key] = value;}};
  });
  const attrs = {viewBox: '0 0 400 120.5'};
  const system = {lyricTop: 100, lyricLineHeight: 17.5, lyricVerses: [0],
    svg: {querySelectorAll: () => words, getAttribute: k => attrs[k], setAttribute: (k, v) => {attrs[k] = v;}}};
  c.packPitchBarLyrics([system]);
  const height = Number(attrs.viewBox.split(' ')[3]);
  assert.equal(new Set(words.map(w => w.getAttribute('y'))).size, 8);
  assert.equal(height, 243);
  for (let i = 0; i < 4; i++) c.packPitchBarLyrics([system]);
  assert.equal(Number(attrs.viewBox.split(' ')[3]), height);
  words.forEach((w, i) => w.setAttribute('x', String(i * 100)));
  c.packPitchBarLyrics([system]);
  assert.equal(Number(attrs.viewBox.split(' ')[3]), 120.5, 'space shrinks back when the lyrics fit');
  assert.ok(words.every(w => w.getAttribute('y') === '100'));
});

test('pitchbar hyphens respect italic ink bearings and leave a readable gap', () => {
  const widths = {'in-': 17.655, in: 13.655, 'vi-': 18, vi: 14, And: 25.712};
  const c = vm.createContext({PITCH_BAR_HYPHEN_LEEWAY: 2,
    measuredSvgTextLength: (text, start) => start === undefined ? widths[text.textContent] : 4});
  for (const name of ['assignLyricLanes', 'relaxLyricHyphens', 'restoreSplitWordHyphens', 'packPitchBarLyrics']) {
    vm.runInContext(source(name), c);
  }
  const words = [['in-', 827.366], ['vi-', 834], ['And', 845.092]].map(([value, x]) => {
    const attrs = {x: String(x), y: '100'};
    return {dataset: {verse: '0'}, textContent: value,
      getAttribute: key => attrs[key], setAttribute: (key, value) => {attrs[key] = value;},
      getBBox() { return {x: x - (value === 'And' ? 1.094 : 0),
        width: widths[this.textContent] + (value === 'And' ? 1.28 : 0)}; }};
  });
  const attrs = {viewBox: '0 0 1000 120.5'};
  c.packPitchBarLyrics([{lyricTop: 100, lyricLineHeight: 17.5, lyricVerses: [0],
    svg: {querySelectorAll: () => words, getAttribute: k => attrs[k], setAttribute: (k, v) => {attrs[k] = v;}}}]);
  assert.equal(words[0].textContent, 'in', 'restoring the dash would touch the capital A');
  assert.equal(words[0].getAttribute('y'), words[2].getAttribute('y'));
  const gap = words[2].getBBox().x - (words[0].getBBox().x + words[0].getBBox().width);
  assert(gap >= 17.5 * .15);
  assert.equal(words[2].getAttribute('x'), '845.092', 'packing must not move the lyric off its note');
});

test('pitchbar visibility always keeps the lyric part, including See solo gestures', () => {
  const c = vm.createContext({scoreView: 'bars', practicePartIndex: 1, parts: [{}, {}, {}, {}],
    visibleTracks: new Set([0]), updateMixerAppearance() {}, updateNoteActionLabel() {},
    savePreferences() {}, scheduleRender() {}, showToast() {}});
  for (const name of ['ensurePracticePartVisible', 'setTrackVisibility', 'aloneOnItsRow', 'turnOnEveryPart', 'soloRow']) {
    vm.runInContext(source(name), c);
  }
  c.ensurePracticePartVisible();
  assert.deepEqual([...c.visibleTracks], [0, 1]);
  c.setTrackVisibility(1, false);
  assert.ok(c.visibleTracks.has(1), 'cannot hide the lyric part');
  const row = {index: 2, required: 1, on: i => c.visibleTracks.has(i), set: c.setTrackVisibility};
  c.soloRow(row, 4);
  assert.deepEqual([...c.visibleTracks].sort(), [1, 2]);
  c.soloRow(row, 4);
  assert.equal(c.visibleTracks.size, 4, 'a second hold restores the full row');
  c.scoreView = 'standard';
  c.setTrackVisibility(1, false);
  c.ensurePracticePartVisible();
  assert.equal(c.visibleTracks.has(1), false, 'standard notation remains unrestricted');
  c.scoreView = 'bars';
  c.practicePartIndex = null;
  c.ensurePracticePartVisible();
  assert.equal(c.visibleTracks.has(null), false);
});
