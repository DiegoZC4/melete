const {test} = require('node:test');
const assert = require('node:assert/strict');
const {compactSpacing, installSpacing} = require('../template/shared_notation.js');
const springs = () => Array.from({length: 4}, (_, i) => ({timePosition: i * 480, preSpringWidth: i ? 5 : 12,
  postSpringWidth: 5, springConstant: 0.04}));

test('minimum lyric spacing respects centered words and left-aligned ownership labels', () => {
  const model = compactSpacing(springs(), [[{tick: 0, width: 80}, {tick: 480, width: 60}],
    [{tick: 480, width: 100, left: 0, right: 100}, {tick: 960, width: 40, left: 0, right: 40}]]);
  const p = model.positions(model.force(0));
  assert.ok(p.get(0) >= 42);
  assert.ok(p.get(480) - p.get(0) >= 73);
  assert.ok(p.get(960) - p.get(480) >= 103);
  assert.ok(model.width(0) >= p.get(960) + 43);
});

test('grace rods keep their fixed leading and trailing space while lyrics stay collision-free', () => {
  const notes = springs(); notes[1].preSpringWidth += 30;
  const info = {springs: new Map(notes.map(n => [n.timePosition, n])), allGraceRods: new Map([[0, [{}]]]),
    version: 1, minStretchForce: 42, calculateVoiceWidth: () => 32, spaceToForce: () => 1, buildOnTimePositions: () => new Map()};
  const factory = {create: () => ({layoutingInfo: info, applyLayoutingInfo() {return this.layoutingInfo.buildOnTimePositions(0);}})};
  installSpacing(factory, () => [[{tick: 0, width: 40}, {tick: 480, width: 70}]]);
  const renderer = factory.create(), p = renderer.applyLayoutingInfo();
  assert.equal(info.minStretchForce, 0);
  assert.ok(p.get(480) - p.get(0) >= 58);
  assert.ok(info.calculateVoiceWidth(0) - p.get(1440) >= 28);
  assert.deepEqual([...renderer.applyLayoutingInfo()], [...p]);
  assert.equal(notes[1].preSpringWidth, 35);
});
