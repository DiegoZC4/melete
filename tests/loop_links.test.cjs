const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const app = fs.readFileSync(path.join(__dirname, '../template/app.js'), 'utf8');
function source(name) {
  const start = app.indexOf(`  function ${name}(`);
  assert(start >= 0, name);
  return app.slice(start, app.indexOf('\n  }', start) + 4);
}
const plain = value => JSON.parse(JSON.stringify(value));
function fixture(href = 'https://example.test/song/') {
  let tick = 0;
  const messages = [], saved = [], loops = [];
  const element = () => ({classList: {toggle() {}, add() {}, remove() {}}, setAttribute() {}, dataset: {}, style: {}});
  const c = vm.createContext({
    URL, URLSearchParams, ready: true, pendingLoopLink: undefined,
    sequence: {division: 960, endTick: 14400,
      measures: [[0,3840,4,4], [3840,2880,6,8], [6720,6720,7,4], [13440,960,4,4]]},
    loopStartMeasure: null, loopEndMeasure: null, loopStartTick: null, loopEndTick: null,
    scoreView: 'standard', clamp: (v, min, max) => Math.max(min, Math.min(max, v)),
    elements: Object.fromEntries(['loopStart', 'loopEnd', 'loopControls', 'loopBand'].map(key => [key, element()])),
    showToast: message => messages.push(message),
    requestAnimationFrame: callback => callback(), playbackDirection: () => null,
    savePreferences: () => saved.push({loopStart:c.loopStartMeasure, loopEnd:c.loopEndMeasure,
      loopStartTick:c.loopStartTick, loopEndTick:c.loopEndTick}),
    engine: {playing: false, pause() { this.playing = false; }, seek(s) { tick = s * 1000; },
      secondsAtTick: t => t / 1000, tickAtSeconds: s => s * 1000, currentSeconds: () => tick / 1000,
      setLoop: (...values) => loops.push(values)},
    api: {pause() {}},
    window: {location: {href}, history: {state: null, replaceState(_state, _title, url) { c.window.location.href = url; }}},
  });
  for (const name of ['measureIndexAtTick', 'currentMeasureIndex', 'scoreLocationAtTick', 'loopLinkValue',
    'loopAddressTick', 'parseLoopLink', 'consumeLoopLink', 'loopTickRange', 'restoreLoopState',
    'applyLoopLink', 'updateLoopState', 'setLoopPoint', 'clearLoop']) vm.runInContext(source(name), c);
  return {c, messages, saved, loops, tick: () => tick};
}

test('URL endpoints are exclusive positions with optional beat and fraction precision', () => {
  const {c} = fixture();
  for (const link of ['2-4', '2.1.0-4.1.0', '2.1-4.1', ' 2 - 4 ']) {
    assert.deepEqual(plain(c.parseLoopLink(link)), {start:3840, end:13440}, link);
  }
  assert.deepEqual(plain(c.parseLoopLink('4-5')), {start:13440, end:14400});
  assert.deepEqual(plain(c.parseLoopLink('1.1.0-5.1.0')), {start:0, end:14400});
});

test('fractional loop beats follow each written denominator and actual bar duration', () => {
  const {c} = fixture();
  assert.deepEqual(plain(c.parseLoopLink('2.2.75-3.6.5')), {start:4680, end:12000});
  assert.deepEqual(plain(c.parseLoopLink('2.2.05-2.2.125')), {start:4344, end:4380});
  for (const link of ['0-1','2-1','2-2','2.1.0-2.1.0','1-6','1-5.2.0','1-4.2.0','4.1.5-4.2',
    '1.5.0-2.2','2.7.0-3.1','1.0.5-2','-1-2','1-2-3','1e1-2','NaN-2','Infinity-2',
    '1.1.-1-2','1.1.x-2','1..5-2','',undefined,null,{},'9'.repeat(101)]) {
    assert.equal(c.parseLoopLink(link), null, String(link));
  }
});

test('query and hash loop fields accept encoded values, prefer hash, and consume only loop', () => {
  const {c} = fixture('https://example.test/song/?part=B2&%6coop=2-3&keep=1#the-seed&LOOP=2.2.75-3.6.5');
  assert.equal(c.loopLinkValue('?loop=1-2', '#the-seed&loop=2.2.75%2D3.6.5'), '2.2.75-3.6.5');
  assert.equal(c.loopLinkValue('?part=B2', '#the-seed'), undefined);
  assert.equal(c.loopLinkValue('?loop=1-2', '#loop='), '');
  assert.equal(c.parseLoopLink(c.loopLinkValue('?loop=%E0%A4%A')), null);
  c.consumeLoopLink();
  assert.equal(c.window.location.href, 'https://example.test/song/?part=B2&keep=1#the-seed');
});

test('loop arrival waits for readiness, then overrides a saved loop without autoplay', () => {
  const {c, saved, loops, tick} = fixture();
  c.ready = false;
  assert.equal(c.applyLoopLink('2.2.75-3.6.5'), true);
  assert.equal(c.pendingLoopLink, '2.2.75-3.6.5');
  assert.equal(saved.length, 0);
  c.ready = true;
  c.engine.playing = true;
  c.applyLoopLink(c.pendingLoopLink);
  assert.equal(c.engine.playing, false);
  assert.equal(tick(), 4680);
  assert.deepEqual(loops.at(-1), [4680,12000]);
  assert.deepEqual(saved.at(-1), {loopStart:1,loopEnd:2,loopStartTick:4680,loopEndTick:12000});
  assert.equal(c.elements.loopStart.textContent, '2.2.75');
  assert.equal(c.elements.loopEnd.textContent, '3.6.5');
  assert.match(c.elements.loopEnd.title, /exclusive/);
  assert.equal(c.applyLoopLink('2-4'), true);
  assert.deepEqual(saved.at(-1), {loopStart:1,loopEnd:2,loopStartTick:null,loopEndTick:null});
  assert.equal(c.elements.loopEnd.textContent, '3');
  assert.match(c.elements.loopEnd.title, /inclusive/);
});

test('invalid links do not overwrite a saved loop, seek, pause, or save', () => {
  const {c, saved, loops, tick, messages} = fixture();
  c.applyLoopLink('2-4');
  c.engine.playing = true;
  assert.equal(c.applyLoopLink('3.7.9-2.1.0'), false);
  assert.equal(c.engine.playing, true);
  assert.equal(tick(), 3840);
  assert.equal(saved.length, 1);
  assert.equal(loops.length, 1);
  assert.match(messages.at(-1), /unchanged/);
});

test('exact loops persist, legacy measure loops still restore, and corrupt ranges are rejected', () => {
  const {c, saved} = fixture();
  c.applyLoopLink('2.2.75-3.6.5');
  const state = saved.at(-1);
  c.clearLoop();
  c.restoreLoopState(state);
  assert.deepEqual(plain(c.loopTickRange()), {start:4680,end:12000});
  c.restoreLoopState({loopStart:1,loopEnd:2});
  assert.deepEqual(plain(c.loopTickRange()), {start:3840,end:13440});
  c.restoreLoopState({loopStart:null,loopEnd:1});
  assert.deepEqual(plain(c.loopTickRange()), {start:0,end:6720});
  c.restoreLoopState({loopStart:1,loopEnd:null});
  assert.deepEqual(plain(c.loopTickRange()), {start:3840,end:null});
  for (const invalid of [{...state,loopStartTick:-1}, {...state,loopEndTick:14400},
    {...state,loopEndTick:'12000'}, {...state,loopStart:99}, {loopStart:2,loopEnd:1}]) {
    c.restoreLoopState(invalid);
    assert.equal(c.loopStartMeasure, null);
    assert.equal(c.loopEndMeasure, null);
  }
});

test('manual endpoints replace only their own fractional boundary; clear resets both', () => {
  const {c, saved, loops} = fixture();
  c.applyLoopLink('2.2.75-3.6.5');
  c.setLoopPoint('start');
  assert.deepEqual(loops.at(-1), [3840,12000]);
  c.engine.seek(7);
  c.setLoopPoint('end');
  assert.deepEqual(loops.at(-1), [3840,13440]);
  c.clearLoop();
  assert.deepEqual(loops.at(-1), [null,null]);
  assert.deepEqual(saved.at(-1), {loopStart:null,loopEnd:null,loopStartTick:null,loopEndTick:null});
});
