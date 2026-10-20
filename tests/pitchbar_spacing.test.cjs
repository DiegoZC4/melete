const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const app = fs.readFileSync(path.join(__dirname, '../template/app.js'), 'utf8');
const start = app.indexOf('  function pitchBarRows(');
const context = vm.createContext({});
vm.runInContext(app.slice(start, app.indexOf('\n  }', start) + 4), context);
const rows = (...args) => JSON.parse(JSON.stringify(context.pitchBarRows(...args)));
const measures = lengths => {
  let tick = 0;
  return lengths.map(length => { const bar = [tick, length]; tick += length; return bar; });
};

test('pitchbar wraps by duration, including pickups and meter changes', () => {
  const bars = measures([480, 3840, 6720, 2880, 1920]);
  const layout = rows(bars, 16 / 240, 650, false);
  assert.deepEqual(layout.map(row => row.measures.length), [2, 2, 1]);
  assert.deepEqual(layout.flatMap(row => row.measures), bars);
  assert.deepEqual(layout.map(row => row.first), [0, 2, 4]);
  assert.deepEqual(layout.map(row => row.plotWidth), [288, 640, 128]);
  for (const row of layout) assert.equal(row.plotWidth / (row.endTick - row.startTick), 16 / 240);
});

test('stretch is linear through 400%, independent of wrapping and viewport', () => {
  const bars = measures([6720, 6720, 3840, 6720]);
  for (const width of [280, 393, 1400, 1900]) {
    for (const percent of [5, 100, 200, 300, 400]) {
      const unitWidth = 16 * percent / 100;
      for (const continuous of [false, true]) {
        const layout = rows(bars, unitWidth / 240, width, continuous);
        assert.deepEqual(layout.flatMap(row => row.measures), bars);
        for (const row of layout) {
          assert.ok(Math.abs(row.plotWidth / (row.endTick - row.startTick) * 240 - unitWidth) < 1e-10);
          if (!continuous && row.plotWidth > width) assert.equal(row.measures.length, 1);
        }
        if (continuous) assert.equal(layout.length, 1);
      }
    }
  }
});

test('one oversized measure stays wide, while the final short line is not justified', () => {
  const layout = rows(measures([6720, 480]), 64 / 240, 350, false);
  assert.equal(layout[0].plotWidth, 1792);
  assert.equal(layout[1].plotWidth, 128);
  assert.deepEqual(rows([], 1, 350, false), []);
});
