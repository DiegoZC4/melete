const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync(require('node:path').join(__dirname,'../template/app.js'),'utf8');
test('native chord spellings preserve added tones and do not rename other cached chords',()=>{
 const code=source.slice(source.indexOf('  function applyWrittenChordNames('),source.indexOf('  function applyLyricFontSettings('));
 const config={writtenChordNames:[{tick:0,name:'Fadd9'},{tick:1920,name:'Am7/D'}]};
 const staff={chords:new Map([['F9',{name:'F9'}],['Am7',{name:'Am7'}]]),hasChord(id){return this.chords.has(id)},addChord(id,c){this.chords.set(id,c)}};
 const beat=(tick,id)=>({absoluteDisplayStart:tick,chordId:id,get chord(){return staff.chords.get(this.chordId)}});
 const beats=[beat(0,'F9'),beat(960,'F9'),beat(1920,'Am7')];
 staff.bars=[{voices:[{beats}]}];
 const score={tracks:[{staves:[staff]}]};
 const apply=vm.runInNewContext(code+'applyWrittenChordNames',{config});
 apply(score);apply(score);
 assert.deepEqual(beats.map(b=>b.chord.name),['Fadd9','F9','Am7/D']);
 assert.equal(staff.chords.size,4);
});
