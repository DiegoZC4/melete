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
class Target {
  listeners = new Map();
  classes = new Set();
  classList = {add: name => this.classes.add(name), remove: name => this.classes.delete(name), contains: name => this.classes.has(name)};
  addEventListener(type, handler, options = {}) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push({handler, signal:options.signal});
  }
  emit(type, event = {}) {
    for (const {handler,signal} of this.listeners.get(type) || []) {
      if (!signal?.aborted) handler({type, preventDefault() {}, ...event});
    }
  }
  setPointerCapture() {}
  hasPointerCapture() { return false; }
}
function fixture() {
  let now = 0;
  const window = new Target(), surface = new Target(), voices = [], seeks = [];
  const c = vm.createContext({window, AbortController, ready:true, pinchActive:false, flow:'wrap',
    scoreScrub:null, pitchAuditions:new Map(), keyboardAudition:null,
    PITCH_AUDITION_HOLD_MS:250, performance:{now:()=>now},
    document:{documentElement:new Target(), getSelection:()=>({removeAllRanges(){}})},
    applyScoreScrubTarget:target => seeks.push(target.tick),
    engine:{ensureAudio(){}, context:{resume:()=>Promise.resolve()}, holdNote(key, track, options) {
      const voice = {key, track, options, active:true}; voices.push(voice);
      return {release:options=>{voice.active=false; voice.releaseOptions=options;}};
    }},
  });
  for (const name of ['cancelScoreScrub','beginScoreScrub','cancelPitchAuditions','beginPitchAudition']) vm.runInContext(source(name),c);
  const press = (note={key:62, track:1}, pointerType='mouse', follow=()=>note, timeStamp) => {
    const event = {button:0, pointerId:1, clientX:100, clientY:100, currentTarget:surface, pointerType, timeStamp};
    const target=e=>({tick:e.clientX});
    if (!c.beginPitchAudition(event,note,follow,target)) c.beginScoreScrub(event,target);
  };
  return {c,window,surface,voices,seeks,press,
    advance(ms) { now += ms; },
    release:timeStamp=>window.emit('pointerup',{pointerId:1,clientX:100,clientY:100,timeStamp}),
  };
}

test('a short press auditions before any timer and seeks only on release', () => {
  const f=fixture(); f.press();
  assert.equal(f.voices.length,1);
  assert.equal(f.voices[0].active,true);
  assert.deepEqual(f.seeks,[]);
  f.advance(100); f.release();
  assert.deepEqual(f.seeks,[100]);
  assert.equal(f.voices[0].active,false);
  assert.equal(f.voices[0].releaseOptions,undefined,'a tap releases immediately without extending the preview');
});
test('dense vertical systems allow horizontal touch panning without audition drag or seek', () => {
  for (const note of [undefined, null]) {
    const f = fixture(); f.surface.classList.add('has-horizontal-overflow');
    f.press(note, 'touch');
    f.window.emit('pointermove', {pointerId:1, clientX:150, clientY:101});
    f.release();
    assert.deepEqual(f.seeks, []);
    assert.ok(f.voices.every(voice => !voice.active));
  }
});
test('even the shortest note and chord taps have no minimum sounding duration', () => {
  for (const ms of [0,5,20,100,249]) for (const pointerType of ['mouse','touch']) {
    for (const note of [{key:60,track:0},{fullChord:true,notes:[{key:60,track:0},{key:55,track:1}]}]) {
      const f=fixture(); f.press(note,pointerType); f.advance(ms); f.release();
      assert.ok(f.voices.every(v=>!v.active && v.releaseOptions===undefined));
      assert.deepEqual(f.seeks,[100]);
    }
  }
});
test('a held note sustains without ever seeking', () => {
  const f=fixture(); f.press(); f.advance(250);
  assert.equal(f.voices[0].active,true);
  f.window.emit('pointermove',{pointerId:1,clientX:200,clientY:100});
  f.release();
  assert.deepEqual(f.seeks,[]);
  assert.equal(f.voices[0].active,false);
});
test('cold audio dispatch delays cannot turn a physical tap into a hold', () => {
  for (const note of [undefined,null]) {
    const f=fixture(); f.press(note,'mouse',undefined,10); f.advance(500); f.release(30);
    assert.deepEqual(f.seeks,[100]);
  }
  const f=fixture(); f.press(undefined,'mouse',undefined,10); f.release(310);
  assert.deepEqual(f.seeks,[],'a real long press still does not seek');
});
test('blank score space is silent and only a short press navigates', () => {
  const f=fixture(); f.press(null); f.advance(300); f.release();
  assert.equal(f.voices.length,0); assert.deepEqual(f.seeks,[]);
  f.press(null); f.release(); assert.deepEqual(f.seeks,[100]);
});
test('scrolling cancels preview and seek, while a deliberate scrub still navigates', () => {
  const f=fixture(); f.press(undefined,'touch');
  f.window.emit('pointermove',{pointerId:1,clientX:102,clientY:120});
  f.advance(300); f.release();
  assert.equal(f.voices[0].active,false); assert.deepEqual(f.seeks,[]);
  f.press(null); f.window.emit('pointermove',{pointerId:1,clientX:108,clientY:100});
  assert.deepEqual(f.seeks,[108]);
});
for (const event of ['pointercancel','lostpointercapture']) test(`${event} cannot leave a note sounding or seek`, () => {
  const f=fixture(); f.press(); f.window.emit(event,{pointerId:1,target:f.surface}); f.advance(300); f.release();
  assert.equal(f.voices[0].active,false); assert.deepEqual(f.seeks,[]);
});
test('canceling previews releases every voice and native touch menus are suppressed', () => {
  const f=fixture(); f.press();
  let prevented=false;
  f.surface.emit('contextmenu',{preventDefault:()=>{prevented=true;}});
  assert.equal(prevented,true);
  f.c.cancelPitchAuditions(); f.c.cancelScoreScrub(); f.advance(300); f.release();
  assert.equal(f.voices[0].active,false); assert.deepEqual(f.seeks,[]);
});
test('standard note hits use noteheads, preserve sounding octave, and ignore invisible parts', () => {
  const box = (key,x,y) => ({note:{realValue:key},noteHeadBounds:{x,y,w:10,h:8}});
  const bar = (track,notes) => ({bar:{staff:{track}},beats:[{notes}]});
  const bars=[bar(0,[box(69,50,30)]),bar(1,[box(57,50,60),box(60,50,68)]),bar(2,[box(40,50,100)])];
  const c=vm.createContext({api:{boundsLookup:{findMasterBarByIndex:()=>({bars})}},sequence:{measures:[[]]},
    elements:{score:{getBoundingClientRect:()=>({left:10,top:20}),scrollLeft:5,scrollTop:10}},
    partIndexForTrack:track=>track, visibleTracks:new Set([0,1])});
  vm.runInContext(source('standardNoteAtClientPoint'),c);
  const at=(x,y)=>c.standardNoteAtClientPoint(x+5,y+10);
  assert.equal(at(55,64).key,57, 'tenor sounds at its actual octave');
  assert.equal(at(55,72).key,60, 'choose the specific note in a chord');
  assert.equal(at(55,104),null);
  assert.equal(at(80,64),null, 'blank beat space is not an audition hit');
  assert.equal(c.standardNoteAtClientPoint(85,74,true).key,57,'dragging follows the nearest written note');
});

test('note drags audition immediately and never turn into scrubbing, even on a quick return', () => {
  const f=fixture();
  f.press(undefined,'mouse',e=>({key:e.clientX>120?64:62,track:1}));
  f.window.emit('pointermove',{pointerId:1,clientX:140,clientY:100});
  assert.equal(f.voices[0].active,false);
  assert.equal(f.voices[1].key,64); assert.equal(f.voices[1].active,true);
  f.window.emit('pointermove',{pointerId:1,clientX:141,clientY:100});
  assert.equal(f.voices.length,2,'same pitch does not retrigger');
  f.window.emit('pointermove',{pointerId:1,clientX:100,clientY:100}); f.release();
  assert.deepEqual(f.seeks,[]); assert.ok(f.voices.every(v=>!v.active));
});
test('chord drags retain common tones and release only changed voices, including complete rests', () => {
  const f=fixture(), initial={fullChord:true,notes:[{key:60,track:0},{key:55,track:1}]};
  f.press(initial,'mouse',e=>e.clientX>160?{notes:[]}:{notes:[{key:60,track:0},{key:57,track:1}]});
  assert.equal(f.voices.length,2); assert.ok(f.voices.every(v=>v.options.fullChord));
  f.window.emit('pointermove',{pointerId:1,clientX:140,clientY:100});
  assert.equal(f.voices[0].active,true); assert.equal(f.voices[1].active,false);
  assert.equal(f.voices[2].key,57);
  f.window.emit('pointermove',{pointerId:1,clientX:180,clientY:100});
  assert.ok(f.voices.every(v=>!v.active)); f.release(); assert.deepEqual(f.seeks,[]);
});
test('chord press on a rest keeps its mode when dragged into sounding notes', () => {
  const f=fixture(); f.press({fullChord:true,notes:[]},'mouse',()=>({notes:[{key:62,track:1}]}));
  assert.equal(f.voices.length,0);
  f.window.emit('pointermove',{pointerId:1,clientX:120,clientY:100});
  assert.equal(f.voices[0].options.fullChord,true); f.release(); assert.deepEqual(f.seeks,[]);
});
test('a late cancellation cannot remove a newer gesture using the same pointer', () => {
  const f=fixture(); f.press(); const oldFinish=f.c.pitchAuditions.get(1);
  f.release(); f.press(); oldFinish();
  assert.equal(f.c.pitchAuditions.size,1); assert.equal(f.voices[1].active,true);
  f.c.cancelPitchAuditions(); assert.equal(f.voices[1].active,false);
});
test('touch keeps vertical scrolling after a hold and both-axis scrolling in horizontal layout', () => {
  const f=fixture(); f.press(undefined,'touch'); f.advance(300);
  f.window.emit('pointermove',{pointerId:1,clientX:102,clientY:130}); f.release();
  assert.equal(f.voices[0].active,false); assert.deepEqual(f.seeks,[]);
  f.c.flow='continuous'; f.press(undefined,'touch');
  f.window.emit('pointermove',{pointerId:1,clientX:130,clientY:100}); f.release();
  assert.equal(f.voices[1].active,false); assert.deepEqual(f.seeks,[]);
});
test('chords include hidden or muted held notes and use half-open duration boundaries', () => {
  const c=vm.createContext({parts:[{},{},{},{}],visibleTracks:new Set([0]),
    sequence:{notes:[[0,0,100,60],[1,0,200,55],[2,100,200,64],[3,0,200,48],[-1,0,200,40],[4,0,200,70]]}});
  vm.runInContext(source('chordNotesAtTick'),c);
  assert.deepEqual(Array.from(c.chordNotesAtTick(100),n=>[n.track,n.key]),[[1,55],[2,64],[3,48]]);
  assert.equal(c.chordNotesAtTick(200).length,0);
});
test('chord strip follows the top of each system and interpolates engraved beat positions', () => {
  const beat=(tick,x)=>({beat:{absolutePlaybackStart:tick},notes:[{noteHeadBounds:{x,w:10}}]});
  const master=y=>({realBounds:{x:10,y:y-60,w:200,h:250},lineAlignedBounds:{y},
    staffSystemBounds:{realBounds:{x:10,y:y-60,w:200,h:250}},
    bars:[{bar:{staff:{track:0}},beats:[beat(0,30),beat(300,150)]}]});
  const c=vm.createContext({api:{boundsLookup:{findMasterBarByIndex:()=>master(100)}},
    elements:{score:{getBoundingClientRect:()=>({left:5,top:20}),scrollLeft:0,scrollTop:0}},
    sequence:{measures:[[0,400]]},visibleTracks:new Set([0]),partIndexForTrack:t=>t,
    currentScorePartIndex:()=>0,clamp:(v,a,b)=>Math.max(a,Math.min(b,v))});
  vm.runInContext(source('performedScoreTick') + source('standardChordTargetAtClientPoint'),c);
  assert.equal(c.standardChordTargetAtClientPoint(95,95).tick,150);
  assert.equal(c.standardChordTargetAtClientPoint(95,125),null,'not between vocal staves');
  assert.equal(c.standardChordTargetAtClientPoint(95,125,false).tick,150,'chord-start drag stays in chord mode');
  assert.equal(c.standardChordTargetAtClientPoint(0,95),null,'not outside the measure');
  assert.equal(c.standardChordTargetAtClientPoint(95,55),null,'not arbitrarily far above the system');
});

function chordBoundaryFixture(bars, data={}) {
  const master={realBounds:{x:10,y:40,w:200,h:250},lineAlignedBounds:{y:100},
    staffSystemBounds:{realBounds:{x:10,y:40,w:200,h:250}},bars};
  const c=vm.createContext({api:{boundsLookup:{findMasterBarByIndex:()=>master}},
    elements:{score:{getBoundingClientRect:()=>({left:17,top:41}),scrollLeft:7,scrollTop:11}},
    sequence:{measures:[[0,400]],...data},visibleTracks:new Set([0,1]),partIndexForTrack:t=>t,
    currentScorePartIndex:()=>0,clamp:(v,a,b)=>Math.max(a,Math.min(b,v))});
  vm.runInContext(source('performedScoreTick') + source('standardChordTargetAtClientPoint'),c);
  return x=>c.standardChordTargetAtClientPoint(x+10,110).tick;
}

test('chord onsets start at notehead left edges, never early through tick rounding', () => {
  const beat=(tick,x,w)=>({beat:{absolutePlaybackStart:tick},notes:[{noteHeadBounds:{x,w}}]});
  for (const width of [4,10,20]) {
    const at=chordBoundaryFixture([{bar:{staff:{track:0}},beats:[beat(0,30,width),beat(300,150,width)]}]);
    assert.ok(at(149.999)<300,'just left of the head still belongs to the preceding chord');
    assert.equal(at(150),300,'the written onset starts at the left edge');
    assert.ok(at(151)>=300,'inside the head no longer sounds late');
    assert.equal(at(90),150,'hidden changes still interpolate between visible onsets');
  }
});

test('simultaneous rests cannot override a notehead and staggered heads use the leftmost edge', () => {
  const head=x=>({noteHeadBounds:{x,w:10}});
  const bars=[
    {bar:{staff:{track:0}},beats:[{beat:{absolutePlaybackStart:0},notes:[head(30)]},
      {beat:{absolutePlaybackStart:300},realBounds:{x:143},notes:[]}]},
    {bar:{staff:{track:1}},beats:[{beat:{absolutePlaybackStart:300},notes:[head(155),head(150)]}]},
  ];
  for (const order of [bars,[...bars].reverse()]) {
    const at=chordBoundaryFixture(order);
    assert.ok(at(149.999)<300);
    assert.equal(at(150),300);
  }
});

test('swung written onsets map to the performed note time, not the preceding pitch', () => {
  const beat=(tick,x)=>({beat:{absolutePlaybackStart:tick},notes:[{noteHeadBounds:{x,w:10}}]});
  for (const [unit,written,performed] of [['16th',20880,20957],['eighth',20640,20794]]) {
    const at=chordBoundaryFixture([{bar:{staff:{track:0}},beats:[beat(19200,30),beat(written,150)]}],
      {measures:[[19200,3840]],division:960,swing:{unit,ratio:66}});
    assert.ok(at(149.999)<performed);
    assert.equal(at(150),performed);
    assert.ok(at(151)>performed);
  }
});
