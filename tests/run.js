/* Beroendefria tester: node tests/run.js */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const root = path.resolve(__dirname, '..');
const store = new Map();

const sandbox = {
  console,
  setTimeout,
  clearTimeout,
  Blob,
  FormData,
  File,
  TextEncoder,
  TextDecoder,
  localStorage: {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k)
  }
};
sandbox.window = sandbox;
vm.createContext(sandbox);

function load(file) {
  vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), sandbox, { filename: file });
}

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ✅ ' + name); }
  catch (e) { failed++; console.error('  ❌ ' + name + '\n     ' + e.message); }
}

(async function run() {
  load('js/config.js');
  load('js/storage.js');
  load('js/zip.js');
  load('js/zipread.js');
  const T = sandbox.TerrariumStore;
  const Z = sandbox.TerrariumZip;
  const ZR = sandbox.TerrariumZipReader;

  console.log('\n🌿 GaGGos Projects 16.0 – tester\n');

  await test('standardinställningar laddas', () => {
    assert.strictEqual(T.settings.provider, 'tmpfiles');
    assert.strictEqual(T.settings.brand.name, 'GaGGos Projects');
    assert.strictEqual(T.settings.theme.wallpaper, true);
    assert.strictEqual(T.settings.theme.useCustom, false);
    assert.strictEqual(T.settings.theme.customWallpaper, false);
    assert.strictEqual(T.settings.theme.wallpaperStyle, 'jungle');
    assert.strictEqual(T.settings.theme.rotateWallpapers, false);
    assert.strictEqual(T.settings.theme.ambient, false);
    assert.strictEqual(JSON.stringify(T.settings.tagColors), '{}');
  });

  await test('fmtBytes formaterar storlekar', () => {
    assert.strictEqual(T.fmtBytes(0), '0 B');
    assert.strictEqual(T.fmtBytes(1024), '1.0 KB');
    assert.strictEqual(T.fmtBytes(1536), '1.5 KB');
    assert.strictEqual(T.fmtBytes(1048576), '1.0 MB');
  });

  await test('adaptrar finns och lokal är demo', () => {
    assert.ok(T.adapters.local && T.adapters.supabase && T.adapters.cloudinary && T.adapters.tmpfiles && T.adapters.catbox);
    assert.strictEqual(T.adapters.local.isDemo, true);
    assert.strictEqual(T.adapters.supabase.canDelete, true);
    assert.strictEqual(T.adapters.cloudinary.canDelete, true, 'mjuk radering ska alltid finnas');
    assert.strictEqual(T.adapters.tmpfiles.canDelete, true);
    assert.strictEqual(T.adapters.catbox.canDelete, true);
  });

  await test('inställningar sparas och kan återställas', () => {
    T.saveSettings({ provider: 'cloudinary', theme: { accent: 'violet', useCustom: true, customAccent: '#ff6b9d' } });
    assert.strictEqual(T.settings.provider, 'cloudinary');
    assert.strictEqual(T.settings.theme.customAccent, '#ff6b9d');
    assert.strictEqual(T.settings.theme.wallpaper, true, 'befintliga fält ska finnas kvar');
    T.resetSettings();
    assert.strictEqual(T.settings.provider, 'tmpfiles');
    assert.strictEqual(T.settings.theme.useCustom, false);
  });

  await test('export/import av metadata fungerar', () => {
    T.importMetadata(JSON.stringify({
      files: [{ id: 'a1', name: 'test.txt', size: 12, url: 'blob:test' }]
    }));
    const parsed = JSON.parse(T.exportMetadata());
    assert.strictEqual(parsed.version, 1);
    assert.strictEqual(parsed.files.length, 1);
    assert.strictEqual(parsed.files[0].name, 'test.txt');
    T.clearMetadata();
    assert.strictEqual(JSON.parse(T.exportMetadata()).files.length, 0);
  });

  await test('aktivitetshistorik sparas och begränsas', () => {
    T.logActivity('upload', 'första.txt');
    T.logActivity('delete', 'gammal.txt');
    const list = T.getActivity();
    assert.strictEqual(list.length, 2);
    assert.strictEqual(list[0].action, 'delete', 'senaste ska ligga först');
    for (let i = 0; i < 105; i++) T.logActivity('star', 'fil' + i);
    assert.strictEqual(T.getActivity().length, 100, 'max 100 poster');
  });

  await test('ZIP innehåller giltiga signaturer och filnamn', async () => {
    const blob = Z.createZip([
      { name: 'hej.txt', data: new Uint8Array([72, 69, 74]) },
      { name: 'mapp/data.json', data: new TextEncoder().encode('{"ok":true}') }
    ]);
    assert.ok(blob instanceof Blob);
    assert.ok(blob.size > 100);
    const buf = new Uint8Array(await blob.arrayBuffer());
    const dv = new DataView(buf.buffer);
    assert.strictEqual(dv.getUint32(0, true), 0x04034B50, 'lokal filheader');
    const text = new TextDecoder().decode(buf);
    assert.ok(text.includes('hej.txt'));
    assert.ok(text.includes('mapp/data.json'));
    // central directory-signatur finns någonstans efter lokal data
    let found = false;
    for (let i = 0; i < buf.length - 4; i++) {
      if (dv.getUint32(i, true) === 0x02014B50) { found = true; break; }
    }
    assert.ok(found, 'central directory');
  });

  await test('CRC32 är stabil', () => {
    assert.strictEqual(Z.crc32(new TextEncoder().encode('123456789')), 0xCBF43926);
  });

  await test('CSV-export innehåller rubriker och citerade fält', () => {
    T.importMetadata(JSON.stringify({ files: [{ id: 'c1', name: 'a,"b".txt', size: 5, tags: ['x', 'y'], pinned: true }] }));
    const csv = T.exportCSV();
    assert.ok(csv.includes('id,name,size'));
    assert.ok(csv.includes('"a,""b"".txt"'));
    assert.ok(csv.includes('x; y'));
    T.clearMetadata();
  });

  await test('utmärkelser låses bara upp en gång', () => {
    assert.strictEqual(T.unlockAchievement('first'), true);
    assert.strictEqual(T.unlockAchievement('first'), false);
    assert.ok(T.getAchievements().includes('first'));
  });

  await test('papperskorg: mjuk radering och återställning', () => {
    T.clearMetadata();
    T.importMetadata(JSON.stringify({ files: [{ id: 't1', name: 'kvar.txt', size: 7, url: 'blob:t1' }] }));
    T.softDelete({ id: 't1', name: 'kvar.txt', size: 7, url: 'blob:t1' });
    assert.strictEqual(JSON.parse(T.exportMetadata()).files.length, 0, 'meta tas bort från Aktiv');
    assert.strictEqual(T.getTrash().length, 1);
    const restored = T.restoreFromTrash('t1');
    assert.strictEqual(restored.name, 'kvar.txt');
    assert.strictEqual(T.getTrash().length, 0);
    assert.strictEqual(JSON.parse(T.exportMetadata()).files.length, 1);
    T.clearMetadata();
  });

  await test('ZIP roundtrip: skriv och läs tillbaka', async () => {
    const payload = new TextEncoder().encode('{"hej":"värld"}');
    const blob = Z.createZip([{ name: 'metadata.json', data: payload }, { name: 'files/001-test.txt', data: new TextEncoder().encode('hej') }]);
    const entries = ZR.read(await blob.arrayBuffer());
    assert.strictEqual(ZR.text(entries, 'metadata.json'), '{"hej":"värld"}');
    assert.strictEqual(ZR.text(entries, 'files/001-test.txt'), 'hej');
  });

  await test('kommandohistorik sparas utan dubbletter', () => {
    T.rememberCommand('Visa insikter');
    T.rememberCommand('Öppna papperskorgen');
    T.rememberCommand('Visa insikter');
    const list = T.getRecentCommands();
    assert.strictEqual(list[0], 'Visa insikter');
    assert.strictEqual(list.filter(x => x === 'Visa insikter').length, 1);
  });

  await test('ändringar sparas som versionssnapshots', () => {
    T.clearMetadata();
    T.importMetadata(JSON.stringify({ files: [{ id: 'v1', name: 'gammal.txt', tags: [], versions: [] }] }));
    T.updateMeta({ id: 'v1', name: 'ny.txt', tags: ['work'], versions: [] });
    const f = JSON.parse(T.exportMetadata()).files.find(x => x.id === 'v1');
    assert.strictEqual(f.name, 'ny.txt');
    assert.strictEqual(f.versions.length, 1);
    assert.ok(f.versions[0].changes.includes('name'));
    assert.strictEqual(f.versions[0].value.name, 'gammal.txt');
    T.clearMetadata();
  });

  await test('ogiltig molnkonfig faller tillbaka till TmpFiles', () => {
    T.saveSettings({ provider: 'cloudinary', cloudinary: { cloudName: '', uploadPreset: '' } });
    assert.strictEqual(T.getAdapter().id, 'tmpfiles', 'tomma nycklar ska inte låsa uppladdningen');
    T.saveSettings({ provider: 'supabase', supabase: { url: 'Gaggo', anonKey: '' } });
    assert.strictEqual(T.getAdapter().id, 'tmpfiles');
    T.saveSettings({ provider: 'cloudinary', cloudinary: { cloudName: 'gaggos-cloud', uploadPreset: 'terrarium_unsigned' } });
    assert.strictEqual(T.getAdapter().id, 'cloudinary', 'giltig konfig ska respekteras');
    T.resetSettings();
  });

  await test('anslutningstest validerar konfiguration', async () => {
    const tmp = await T.testConnection('tmpfiles');
    assert.strictEqual(tmp.ok, true);
    const cat = await T.testConnection('catbox');
    assert.strictEqual(typeof cat.ok, 'boolean', 'Catbox-test ska inte krascha utan proxy');
    const bad = await T.testConnection('cloudinary', { cloudinary: { cloudName: '', uploadPreset: '' } });
    assert.strictEqual(bad.ok, false);
    const good = await T.testConnection('cloudinary', { cloudinary: { cloudName: 'gaggo-cloud', uploadPreset: 'terrarium_unsigned' } });
    assert.strictEqual(good.ok, true);
    const badSupa = await T.testConnection('supabase', { supabase: { url: 'Gaggo', anonKey: '' } });
    assert.strictEqual(badSupa.ok, false);
  });

  console.log(`\n${passed} tester godkända, ${failed} misslyckade 🌿\n`);
  if (failed) process.exitCode = 1;
})();
