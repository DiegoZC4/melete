const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const app = fs.readFileSync(path.join(__dirname, '../template/app.js'), 'utf8');
const start = app.indexOf('  function preferenceDefaults(');
const source = app.slice(start, app.indexOf('\n  }', start) + 4);

test('shared mobile defaults match Get It Right while explicit song scales still win', () => {
  for (const mobile of [false, true]) for (const vertical of [undefined, 85, 100]) {
    const context = vm.createContext({
      window: {matchMedia: () => ({matches: mobile})}, config: {defaults: {vertical}}, parts: [],
      nearestAllowed: value => value, clamp: value => value,
      TEMPO_VALUES: [], METRONOME_VALUES: [], VERTICAL_VALUES: [], HORIZONTAL_VALUES: [],
    });
    vm.runInContext(source, context);
    assert.equal(context.preferenceDefaults().vertical, vertical ?? (mobile ? 70 : 100));
    assert.equal(context.preferenceDefaults().horizontal, 100);
  }
});

test('song volume defaults allow a 200 percent ceiling with 100 percent as normal', () => {
  const context = vm.createContext({
    window: {matchMedia: () => ({matches: false})}, config: {defaults: {volumes: [200, 175, 250, -5]}},
    parts: Array(5).fill({}), nearestAllowed: value => value,
    clamp: (value, low, high) => Math.max(low, Math.min(high, value)),
    TEMPO_VALUES: [], METRONOME_VALUES: [], VERTICAL_VALUES: [], HORIZONTAL_VALUES: [], PAN_VALUES: [],
  });
  vm.runInContext(app.split('\n').find(line => line.includes('const VOLUME_VALUES =')) + '\n' + source, context);
  assert.deepEqual(Array.from(context.preferenceDefaults().volumes), [200, 175, 200, 0, 100]);
});
