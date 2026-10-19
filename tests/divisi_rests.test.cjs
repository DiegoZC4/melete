const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {test} = require('node:test');
const vm = require('node:vm');

test('only down-stem voice-2 rests use the lower collision branch', () => {
  const source = fs.readFileSync(path.join(__dirname, '../template/app.js'), 'utf8');
  const start = source.indexOf('  function installLowerVoiceRestPlacement()');
  const end = source.indexOf('  function demoVideoAddress(', start);
  assert(start >= 0 && end > start);
  const calls = [];
  const helper = {applyRestCollisionOffset(beat, y, step) {
    assert.equal(this, helper);
    calls.push({beat, y, step});
    return beat.voice.index === 1 ? -20 : 20;
  }};
  const renderer = {collisionHelper: helper, getBeatDirection: beat => beat.direction};
  const factory = {staffId: 'score', create(...args) {
    assert.equal(this, factory);
    assert.deepEqual(args, ['score', 'bar']);
    return renderer;
  }};
  const tab = {staffId: 'tab', create() { throw new Error('Tab renderer must be untouched'); }};
  const originalTab = tab.create;
  const window = {alphaTab: {Environment: {defaultRenderers: [factory, tab]},
    rendering: {BeamDirection: {Up: 0, Down: 1}}}};
  const context = vm.createContext({window});
  vm.runInContext(source.slice(start, end) + '\ninstallLowerVoiceRestPlacement();', context);
  const wrapped = factory.create;
  vm.runInContext('installLowerVoiceRestPlacement();', context);
  assert.equal(factory.create, wrapped);
  assert.equal(tab.create, originalTab);
  const actual = factory.create('score', 'bar');
  for (const [index, direction, isRest] of [[1, 1, true], [1, 0, true], [0, 1, true], [2, 1, true], [1, 1, false]]) {
    const beat = {id: 11, voice: {index}, direction, isRest, playbackStart: 960, playbackDuration: 240};
    const before = JSON.stringify(beat);
    actual.collisionHelper.applyRestCollisionOffset(beat, 18, 4.5);
    const call = calls.at(-1);
    const lower = index === 1 && direction === 1 && isRest;
    assert.equal(call.beat.voice.index, lower ? 2 : index);
    assert.equal(call.y, 18);
    assert.equal(call.step, 4.5);
    assert.equal(call.beat.id, beat.id);
    assert.equal(call.beat.playbackStart, 960);
    assert.equal(call.beat.playbackDuration, 240);
    assert.equal(JSON.stringify(beat), before);
    if (!lower) assert.equal(call.beat, beat);
  }
});
