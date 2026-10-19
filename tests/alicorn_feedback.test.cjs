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
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

test('divisi pitch-trace lanes still map across changing voice counts', () => {
  const c = vm.createContext({clamp});
  vm.runInContext(source('divisiLineFor'),c);
  assert.equal(c.divisiLineFor(0,2,2),0);
  assert.equal(c.divisiLineFor(1,2,2),1);
  assert.equal(c.divisiLineFor(1,3,2),1);
  assert.equal(c.divisiLineFor(1,2,1),0);
});

test('retired per-mixer divisi choices and drag icons are neither applied nor saved', () => {
  assert.doesNotMatch(app,/divisiSelections|setDivisi|filterDivisiNotes|addDragAffordance/);
  for (const name of ['applyPreferenceState','applySettingsState','currentPreferenceState','captureSettingsState']) {
    assert.doesNotMatch(source(name),/\bdivisi\b/);
  }
});

test('follow geometry uses the sounding measure even while the DOM cursor is still on the previous system', () => {
  const boxes = [{x:10,y:100,w:200,h:300},{x:10,y:600,w:200,h:300}];
  const c = vm.createContext({clamp, pendingNotationReload:null,scoreView:'standard',sequence:{endTick:800},
    engine:{currentSeconds:()=>500,tickAtSeconds:t=>t},measureIndexAtTick:t=>t<400?0:1,
    masterBarLayoutBox:i=>boxes[i],
    elements:{score:{classList:{contains:()=>false},getBoundingClientRect:()=>({left:20,top:-50}),scrollLeft:0,scrollTop:0}}});
  vm.runInContext(source('playbackCursorBounds'),c);
  assert.deepEqual(plain(c.playbackCursorBounds()),{left:30,top:550,right:230,bottom:850,width:200,height:300});
});

test('paused position changes cannot start a follow-scroll', () => {
  const c=vm.createContext({engine:{playing:false},pendingNotationReload:null,scoreScrub:null});
  vm.runInContext(source('gentleFollowCursor'),c);
  assert.doesNotThrow(()=>c.gentleFollowCursor(),'must exit before touching the page or stale cursor');
});

test('arrow navigation follows note onsets, includes slur notes, skips rests and does not wrap', () => {
  const sounded=[], seeks=[];
  let position=0, timer;
  const c=vm.createContext({ready:true,api:{},keyboardAudition:null,KEYBOARD_NOTE_PREVIEW_SECONDS:.22,
    currentScorePartIndex:()=>1,playbackCursorPlace:()=>'',followCursorFrom(){},cancelPitchAuditions(){},
    window:{setTimeout:fn=>{timer=fn;return 1;},clearTimeout(){}},
    engine:{notes:[{track:0,start:.25,end:1,key:70},
      {track:1,start:0,end:3,key:60}, {track:1,start:3,end:4,key:62},
      {track:1,start:5,end:7,key:64,segments:[{track:1,start:5,end:6,key:64},{track:1,start:6,end:7,key:65}]}],
      currentSeconds:()=>position,tickAtSeconds:t=>t*960,pauseTransport(){},
      holdNote:key=>{sounded.push(key); return {release(){}};}},
    applyScoreScrubTarget:target=>{position=target.tick/960;seeks.push(position);},
  });
  vm.runInContext(source('stepScoreNote'),c);
  c.stepScoreNote(1); c.stepScoreNote(1); c.stepScoreNote(1); c.stepScoreNote(1);
  assert.deepEqual(seeks,[3,5,6]); assert.deepEqual(sounded,[62,64,65]);
  c.stepScoreNote(-1); assert.equal(position,5); timer();
  assert.equal(c.keyboardAudition,null);
});
