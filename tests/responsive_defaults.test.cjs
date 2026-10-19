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
