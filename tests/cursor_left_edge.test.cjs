const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../template/app.js'), 'utf8');
const start = source.indexOf('  function createLeftEdgeCursorHandler(');
const create = vm.runInNewContext(source.slice(start, source.indexOf('\n  }', start) + 4) + '\ncreateLeftEdgeCursorHandler');

function fixture(scale = 1) {
  const alpha = {model: {MusicFontSymbol: {RestQuarter: 1, RestWhole: 2}},
    midi: {MidiTickLookupFindBeatResultCursorMode: {ToNextBext: 0}}};
  const player = {settings: {display: {scale, resources: {engravingSettings: {glyphWidths: new Map([[1, 8], [2, 12]])}}}}};
  const system = {realBounds: {x: 0, w: 300}, bars: []};
  const master = {index: 0, staffSystemBounds: system, visualBounds: {x: 0, y: 40, w: 300, h: 160}, bars: []};
  const bar = {masterBarBounds: master, beats: []};
  master.bars.push(bar); system.bars.push(master);
  const add = (center, tick, left, rest = false, full = false) => {
    const b = {barBounds: bar, onNotesX: center, realBounds: {x: 80, w: 140},
      beat: {isRest: rest, isFullBarRest: full, duration: 4, absoluteDisplayStart: tick},
      notes: left === null ? [] : [{noteHeadBounds: {x: left}}]};
    bar.beats.push(b); return b;
  };
  const first = add(100, 0, 94), second = add(200, 480, 192);
  const handler = create(alpha, player), calls = [];
  const cursor = {setBounds: (...args) => calls.push(['bounds', ...args]), transitionToX: (...args) => calls.push(['move', ...args])};
  return {handler, cursor, calls, first, second, add, bar, master};
}

test('cursor touches notehead left edges and interpolates without moving score anchors', () => {
  const f = fixture();
  f.handler.placeBeatCursor(f.cursor, f.first, 100);
  assert.deepEqual(f.calls.at(-1), ['bounds', 94, 40, 1, 160]);
  f.handler.placeBeatCursor(f.cursor, f.first, 150);
  assert.equal(f.calls.at(-1)[1], 143);
  f.handler.placeBeatCursor(f.cursor, f.second, 200);
  assert.equal(f.calls.at(-1)[1], 192);
  assert.equal(f.first.onNotesX, 100);
});

test('rests use scaled glyph edges; full-bar rests use their centered content span', () => {
  for (const scale of [0.7, 1, 1.5]) {
    const f = fixture(scale); f.bar.beats.length = 0;
    const rest = f.add(100, 0, null, true);
    const full = f.add(200, 480, null, true, true);
    f.handler.placeBeatCursor(f.cursor, rest, 100);
    assert.ok(Math.abs(f.calls.at(-1)[1] - (100 - 4 * scale)) < 1e-8);
    f.handler.placeBeatCursor(f.cursor, full, 200);
    assert.ok(Math.abs(f.calls.at(-1)[1] - (150 - 6 * scale)) < 1e-8);
  }
});

test('a simultaneous full-bar rest cannot displace a sounding onset in another part', () => {
  const f = fixture(); f.add(100, 0, null, true, true);
  f.handler.placeBeatCursor(f.cursor, f.first, 100);
  assert.equal(f.calls.at(-1)[1], 94);
});

test('animation retains native continuous transition and bar highlight dimensions', () => {
  const f = fixture();
  f.handler.transitionBeatCursor(f.cursor, f.first, 100, 200, 500, 0);
  assert.deepEqual(f.calls.at(-1), ['move', 1000, 290]);
  f.handler.transitionBeatCursor(f.cursor, f.first, 150, 200, 250, 1);
  assert.deepEqual(f.calls.at(-1), ['move', 250, 192]);
  f.handler.placeBarCursor(f.cursor, f.first);
  assert.deepEqual(f.calls.at(-1), ['bounds', 0, 40, 300, 160]);
});
