const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const app = fs.readFileSync(path.join(__dirname, '../template/app.js'), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
function source(name) {
  const start = app.indexOf(`  function ${name}(`);
  assert.ok(start >= 0, name);
  return app.slice(start, app.indexOf('\n  }', start) + 4);
}
function fixture(raw) {
  const c = vm.createContext({parts: [{}, {}], sequence: {notes: raw}, partDivisi: [],
    clamp: (n, lo, hi) => Math.max(lo, Math.min(hi, n))});
  for (const name of ['analysePartDivisi', 'divisiLineFor', 'divisiPlaybackNotes',
    'practiceDivisiOptions', 'normalizePracticeDivisi']) vm.runInContext(source(name), c);
  c.partDivisi = c.analysePartDivisi();
  const notes = raw.map(([track, start, end, key]) => ({track, start, end, key}));
  return {c, notes, play: (line, input = notes) => c.divisiPlaybackNotes(input, 0, line, t => t)};
}

test('only genuine simultaneous distinct pitches add a numbered pager', () => {
  const unison = fixture([[0,0,1,60],[0,1,2,64],[0,1,2,64],[1,0,2,48]]);
  assert.deepEqual(plain(unison.c.practiceDivisiOptions(0)), []);
  assert.deepEqual(plain(unison.c.practiceDivisiOptions(null)), []);
  const split = fixture([[0,0,1,72],[0,0,1,67],[0,0,1,60],[1,0,1,48]]);
  assert.deepEqual(plain(split.c.practiceDivisiOptions(0)), [
    {value:null,label:'All Div'}, {value:0,label:'Div 1'}, {value:1,label:'Div 2'}, {value:2,label:'Div 3'}]);
  assert.deepEqual(plain(split.c.practiceDivisiOptions(1)), []);
  assert.deepEqual(plain(split.c.normalizePracticeDivisi([2, 0])), [2,null]);
  for (const values of [undefined, [-1,0], [3,0], ['1',0]])
    assert.deepEqual(plain(split.c.normalizePracticeDivisi(values)), [null,null]);
});

test('all divisions preserves originals; filtering affects only the chosen part', () => {
  const f = fixture([[0,0,1,72],[0,0,1,60],[0,1,2,64],[1,0,2,48]]);
  assert.equal(f.play(null), f.notes);
  assert.equal(f.play(8), f.notes);
  for (const [line,key] of [[0,72],[1,60]]) {
    const played = f.play(line);
    assert.deepEqual(played.filter(n=>n.track===0).map(n=>n.key), [key,64]);
    assert.equal(played.find(n=>n.track===1), f.notes[3]);
  }
  assert.equal(f.notes.length, 4, 'source and audition notes remain intact');
});

test('a held unison note splits correctly when another division enters and leaves', () => {
  const f = fixture([[0,0,4,60],[0,1,3,72]]);
  assert.deepEqual(plain(f.play(0)), [
    {track:0,start:0,end:1,key:60},{track:0,start:1,end:3,key:72},{track:0,start:3,end:4,key:60}]);
  assert.deepEqual(plain(f.play(1)), [{track:0,start:0,end:4,key:60}]);
  assert.equal(f.notes[0].end,4);
});

test('legato stays joined, but a rejected middle note cannot leak through its phrase', () => {
  const f = fixture([[0,0,1,72],[0,1,2,74],[0,2,3,76],[0,0,3,60]]);
  const phrase = {...f.notes[0],end:3,segments:f.notes.slice(0,3)};
  assert.equal(f.play(0,[phrase,f.notes[3]])[0],phrase);
  assert.deepEqual(plain(f.play(1,[phrase,f.notes[3]])), [f.notes[3]]);
  const crossing = fixture([[0,0,1,72],[0,1,2,55],[0,2,3,76],[0,0,3,60]]);
  const crossed = {...crossing.notes[0],end:3,segments:crossing.notes.slice(0,3)};
  assert.deepEqual(plain(crossing.play(0,[crossed,crossing.notes[3]])), [
    {track:0,start:0,end:1,key:72},{track:0,start:1,end:2,key:60},{track:0,start:2,end:3,key:76}]);
});

test('three divisions map to fewer voices and tempo-converted boundaries', () => {
  const f = fixture([[0,0,1,72],[0,0,1,67],[0,0,1,60],[0,1,2,74],[0,1,2,62],[0,2,3,65]]);
  assert.deepEqual(f.play(1).map(n=>n.key), [67,62,65]);
  const converted = f.notes.map(n=>({...n,start:n.start*2,end:n.end*2}));
  assert.deepEqual(plain(f.c.divisiPlaybackNotes(converted,0,0,t=>t*2)),
    [{track:0,start:0,end:2,key:72},{track:0,start:2,end:4,key:74},{track:0,start:4,end:6,key:65}]);
});
