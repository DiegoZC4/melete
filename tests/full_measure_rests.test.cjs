const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const app = fs.readFileSync(path.join(__dirname, '../template/app.js'), 'utf8');
const source = app.slice(app.indexOf('  function centerFullMeasureRests()'),
  app.indexOf('  function scheduleFullMeasureRestCentering()'));

function fixture({scale = 1, full = true, empty = false, known = true} = {}) {
  const owner = {classList: ['b12'], parentElement: null};
  const group = {classList: ['at'], parentElement: owner, dataset: {}, transform: '',
    getAttribute() { return this.transform; },
    setAttribute(_name, value) { this.transform = value; },
    getScreenCTM() { return {a: scale}; }};
  const rest = {textContent: '\uE4E3', parentElement: group,
    getBoundingClientRect() {
      const dx = Number(group.transform.match(/translate\(([-\d.]+)/)?.[1] || 0) * scale;
      return {left:128 * scale - 5 + dx, top:80 * scale, width:10, height:30};
    }};
  const bar = {realBounds:{x:40 * scale,y:60 * scale,w:120 * scale,h:80 * scale}, bars:[{
    beats:[{beat:{id:known ? 12 : 13,isFullBarRest:full,isEmpty:empty},
      realBounds:{x:120 * scale,y:80 * scale,w:36 * scale,h:36 * scale}}],
  }]};
  const score = {dataset:{},scrollLeft:0,scrollTop:0,
    getBoundingClientRect:()=>({left:0,top:0}),querySelectorAll:()=>[rest]};
  const context = vm.createContext({api:{boundsLookup:{findMasterBarByIndex:()=>bar}},
    sequence:{measures:[[0,6720]]}, elements:{score}});
  vm.runInContext(source, context);
  return {run:()=>context.centerFullMeasureRests(),group,rest,score};
}

for (const scale of [.7,1,1.4]) test(`measure rests clear opening symbols at ${scale * 100}% scale`, () => {
  const f=fixture({scale});
  f.run();
  const center=()=>{const r=f.rest.getBoundingClientRect();return r.left+r.width/2;};
  assert.ok(Math.abs(center()-138 * scale)<1e-6, 'center only the post-signature musical span');
  const transform=f.group.transform;
  f.run();
  assert.equal(f.group.transform,transform,'repeated paint passes do not accumulate a shift');
  assert.equal(f.group.dataset.fullRestMeasure,'1');
});

for (const options of [{full:false},{empty:true},{known:false}]) test(`only matched, genuine full-measure rests move: ${JSON.stringify(options)}`, () => {
  const f=fixture(options);
  f.run();
  assert.equal(f.group.transform,'');
  assert.notEqual(f.group.dataset.fullRestCentered,'true');
});
