const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const app = fs.readFileSync(path.join(__dirname, '../template/app.js'), 'utf8');
const start = app.indexOf('  async function downloadMuseScore(');
assert.ok(start >= 0);
const source = app.slice(start, app.indexOf('\n  }', start) + 4);

function fixture(picker) {
  const attrs = new Map(), events = [], downloads = [], writes = [], toasts = [];
  const bytes = Buffer.from('PK\x03\x04saved score');
  const button = {
    getAttribute: key => attrs.get(key),
    setAttribute: (key, value) => attrs.set(key, value),
    removeAttribute: key => attrs.delete(key),
  };
  const c = vm.createContext({Blob, config: {sourceScore: {filename:'Get It Right.mscz', data:bytes.toString('base64')}},
    elements: {downloadScore:button}, window: {isSecureContext:true, showSaveFilePicker:picker},
    base64ToBytes: data => { events.push('decode'); return Buffer.from(data, 'base64'); },
    writeStandaloneFile: async (handle, blob) => writes.push({handle, blob}),
    saveStandaloneBlob: (blob, filename) => downloads.push({blob, filename}),
    showToast: (...args) => toasts.push(args), console: {warn(){}, error(){}},
  });
  vm.runInContext(source, c);
  return {c, bytes, events, downloads, writes, toasts, attrs};
}

test('source-score picker opens before decoding and saves original bytes', async () => {
  let options;
  const handle = {};
  const f = fixture(o => {options = o; f.events.push('picker'); return Promise.resolve(handle);});
  assert.deepEqual(f.events, []);
  const saving = f.c.downloadMuseScore();
  assert.deepEqual(f.events, ['picker'], 'picker is requested in the initial click turn');
  await saving;
  assert.equal(options.suggestedName, 'Get It Right.mscz');
  assert.equal(options.types[0].accept['application/octet-stream'][0], '.mscz');
  assert.equal(f.writes[0].handle, handle);
  assert.deepEqual(Buffer.from(await f.writes[0].blob.arrayBuffer()), f.bytes);
  assert.equal(f.downloads.length, 0);
  assert.equal(f.attrs.has('aria-busy'), false);
});

test('canceling the source-score picker never falls back to a download', async () => {
  const f = fixture(async () => {throw Object.assign(new Error('Canceled'), {name:'AbortError'});});
  await f.c.downloadMuseScore();
  assert.deepEqual(f.events, []);
  assert.equal(f.downloads.length, 0);
  assert.equal(f.writes.length, 0);
  assert.equal(f.toasts.length, 0);
  assert.equal(f.attrs.has('aria-busy'), false);
});

for (const state of ['unsupported', 'insecure', 'rejected']) test(`${state} picker uses the normal download`, async () => {
  const f = fixture(state === 'unsupported' ? undefined : async () => {throw new Error('Picker unavailable');});
  if (state === 'insecure') f.c.window.isSecureContext = false;
  await f.c.downloadMuseScore();
  assert.equal(f.downloads.length, 1);
  assert.equal(f.downloads[0].filename, 'Get It Right.mscz');
  assert.equal(f.downloads[0].blob.type, 'application/octet-stream');
  assert.deepEqual(Buffer.from(await f.downloads[0].blob.arrayBuffer()), f.bytes);
  assert.equal(f.writes.length, 0);
});

test('repeated clicks do not open a second picker', async () => {
  let finish, calls = 0;
  const f = fixture(() => {calls++; return new Promise(resolve => {finish = resolve;});});
  const first = f.c.downloadMuseScore();
  await f.c.downloadMuseScore();
  assert.equal(calls, 1);
  finish({});
  await first;
  assert.equal(f.writes.length, 1);
});

test('write failures report an error without a second download', async () => {
  const f = fixture(async () => ({}));
  f.c.writeStandaloneFile = async () => {throw new Error('Disk full');};
  await f.c.downloadMuseScore();
  assert.equal(f.toasts[0][1], 'error');
  assert.equal(f.downloads.length, 0);
  assert.equal(f.attrs.has('aria-busy'), false);
});
