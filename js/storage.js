/* ============================================================
   TERRARIUM — lagringslager
   Tre adaptrar: local (IndexedDB-demo), supabase, cloudinary.
   Alla exponerar: init, upload(file, onProgress), remove(meta),
   list(), getUrl(meta), canDelete.
   ============================================================ */
(function () {
  'use strict';

  var LS_SETTINGS = 'terrarium.settings.v1';
  var LS_FILES = 'terrarium.files.v1';
  var LS_ACTIVITY = 'terrarium.activity.v1';
  var LS_ACHIEVEMENTS = 'terrarium.achievements.v1';
  var LS_TRASH = 'terrarium.trash.v1';
  var LS_RECENT = 'terrarium.recent.v1';
  var DB_NAME = 'terrarium-files';
  var STORE = 'files';

  var base = window.TERRARIUM_CONFIG || {};
  var settings = merge(base, readJSON(LS_SETTINGS, {}));
  var objectUrls = {}; // id -> blob url (local adapter)

  function isPlainObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

  // Djup merge där b alltid vinner (tidigare ignorerades befintliga nycklar,
  // vilket gjorde att sparade inställningar aldrig tog effekt).
  function merge(a, b) {
    var out = {};
    Object.keys(a || {}).forEach(function (k) {
      out[k] = isPlainObject(a[k]) ? merge(a[k], {}) : a[k];
    });
    Object.keys(b || {}).forEach(function (k) {
      out[k] = (isPlainObject(b[k]) && isPlainObject(out[k]))
        ? merge(out[k], b[k]) : b[k];
    });
    return out;
  }

  function readJSON(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) { return fallback; }
  }

  function writeJSON(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; }
    catch (e) { return false; }
  }

  function uid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'f_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
  }

  function safeName(name) {
    return String(name || 'file').replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'file';
  }

  function encPath(path) {
    return String(path).split('/').map(encodeURIComponent).join('/');
  }

  function fmtBytes(n) {
    if (!n && n !== 0) return '–';
    var units = ['B', 'KB', 'MB', 'GB', 'TB'];
    var i = 0;
    n = Number(n);
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return (i === 0 ? n : n.toFixed(n < 10 ? 1 : 0)) + ' ' + units[i];
  }

  function localFiles() { return readJSON(LS_FILES, []); }
  function saveLocalFiles(list) { writeJSON(LS_FILES, list); }

  function upsertLocal(meta) {
    var list = localFiles();
    var i = list.findIndex(function (f) { return f.id === meta.id; });
    if (i >= 0) list[i] = meta; else list.unshift(meta);
    saveLocalFiles(list);
    return meta;
  }

  function removeLocal(id) {
    saveLocalFiles(localFiles().filter(function (f) { return f.id !== id; }));
  }

  /* ---------- IndexedDB-hjälp ---------- */
  function openDB() {
    return new Promise(function (resolve, reject) {
      if (!window.indexedDB) return reject(new Error('IndexedDB stöds inte'));
      var req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error || new Error('DB-fel')); };
    });
  }

  function idbPut(key, value) {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(value, key);
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  function idbGet(key) {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, 'readonly');
        var r = tx.objectStore(STORE).get(key);
        r.onsuccess = function () { resolve(r.result); };
        r.onerror = function () { reject(r.error); };
      });
    });
  }

  function idbDelete(key) {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).delete(key);
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  /* ---------- XHR med progress ---------- */
  function xhrSend(opts) {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      if (opts.signal) {
        if (opts.signal.aborted) return reject(new DOMException('Avbruten', 'AbortError'));
        opts.signal.addEventListener('abort', function () { xhr.abort(); }, { once: true });
      }
      xhr.onabort = function () { reject(new DOMException('Avbruten', 'AbortError')); };
      xhr.open(opts.method || 'GET', opts.url);
      Object.keys(opts.headers || {}).forEach(function (k) {
        xhr.setRequestHeader(k, opts.headers[k]);
      });
      if (opts.onProgress) {
        xhr.upload.onprogress = function (e) {
          if (e.lengthComputable) opts.onProgress(Math.min(100, Math.round(e.loaded / e.total * 100)));
        };
      }
      xhr.onload = function () {
        var body = null;
        try { body = xhr.responseText ? JSON.parse(xhr.responseText) : null; } catch (e) { body = xhr.responseText; }
        if (xhr.status >= 200 && xhr.status < 300) resolve(body || {});
        else reject(new Error((body && (body.message || body.error)) || ('HTTP ' + xhr.status)));
      };
      xhr.onerror = function () { reject(new Error('Nätverksfel – kolla uppkoppling och CORS.')); };
      xhr.send(opts.body || null);
    });
  }

  /* ============================================================
     LOKAL ADAPTER (demo, filer stannar i webbläsaren)
     ============================================================ */
  var LocalAdapter = {
    id: 'local',
    name: 'Lokal demo',
    canDelete: true,
    isDemo: true,

    init: function () { return Promise.resolve(true); },

    upload: function (file, onProgress) {
      var id = uid();
      onProgress && onProgress(6);
      return new Promise(function (r) { setTimeout(r, 90); }).then(function () {
        onProgress && onProgress(62);
        return idbPut(id, file);
      }).then(function () {
        onProgress && onProgress(100);
        var url = URL.createObjectURL(file);
        objectUrls[id] = url;
        return upsertLocal({
          id: id,
          name: file.name,
          size: file.size,
          type: file.type || 'application/octet-stream',
          path: id,
          url: url,
          local: true,
          createdAt: new Date().toISOString(),
          starred: false,
          tags: []
        });
      });
    },

    list: function () {
      var metas = localFiles();
      return Promise.all(metas.map(function (m) {
        if (!m.local) return m;
        return idbGet(m.id).then(function (blob) {
          if (blob) {
            if (!objectUrls[m.id]) objectUrls[m.id] = URL.createObjectURL(blob);
            m.url = objectUrls[m.id];
          }
          return m;
        }).catch(function () { return m; });
      }));
    },

    remove: function (meta) {
      if (objectUrls[meta.id]) { URL.revokeObjectURL(objectUrls[meta.id]); delete objectUrls[meta.id]; }
      removeLocal(meta.id);
      return idbDelete(meta.id).catch(function () {});
    },

    getUrl: function (meta) { return Promise.resolve(meta.url || ''); }
  };

  /* ============================================================
     SUPABASE ADAPTER
     ============================================================ */
  function sbConfig() { return settings.supabase || {}; }

  function sbHeaders(extra) {
    var c = sbConfig();
    var h = {
      'apikey': c.anonKey || '',
      'Authorization': 'Bearer ' + (c.anonKey || '')
    };
    Object.keys(extra || {}).forEach(function (k) { h[k] = extra[k]; });
    return h;
  }

  var SupabaseAdapter = {
    id: 'supabase',
    name: 'Supabase',
    canDelete: true,
    isDemo: false,

    init: function () {
      var c = sbConfig();
      if (!c.url || !c.anonKey) return Promise.reject(new Error('Supabase-URL och anon-nyckel saknas.'));
      return Promise.resolve(true);
    },

    upload: function (file, onProgress, signal) {
      var c = sbConfig();
      var id = uid();
      var path = new Date().getFullYear() + '/' +
        String(new Date().getMonth() + 1).padStart(2, '0') + '/' +
        id + '-' + safeName(file.name);
      var objectUrl = String(c.url).replace(/\/$/, '') +
        '/storage/v1/object/' + encodeURIComponent(c.bucket || 'vault') + '/' + encPath(path);
      var publicUrl = String(c.url).replace(/\/$/, '') +
        '/storage/v1/object/public/' + encodeURIComponent(c.bucket || 'vault') + '/' + encPath(path);

      return xhrSend({
        method: 'POST',
        url: objectUrl,
        headers: sbHeaders({
          'Content-Type': file.type || 'application/octet-stream',
          'x-upsert': 'false',
          'cache-control': '3600'
        }),
        body: file,
        onProgress: onProgress,
        signal: signal
      }).then(function () {
        var meta = {
          id: id,
          name: file.name,
          size: file.size,
          type: file.type || 'application/octet-stream',
          path: path,
          url: publicUrl,
          createdAt: new Date().toISOString(),
          starred: false,
          tags: []
        };
        upsertLocal(meta);
        if (c.syncMetadata) {
          return xhrSend({
            method: 'POST',
            url: String(c.url).replace(/\/$/, '') + '/rest/v1/vault_files',
            headers: sbHeaders({ 'Content-Type': 'application/json', 'Prefer': 'return=minimal' }),
            body: JSON.stringify({
              id: meta.id, name: meta.name, size: meta.size, type: meta.type,
              path: meta.path, url: meta.url, createdAt: meta.createdAt,
              starred: false, tags: []
            })
          }).then(function () { return meta; }).catch(function (e) {
            console.warn('[Terrarium] Metadata kunde inte synkas:', e.message);
            meta.syncWarning = true;
            upsertLocal(meta);
            return meta;
          });
        }
        return meta;
      });
    },

    list: function () {
      var c = sbConfig();
      if (!c.syncMetadata) return Promise.resolve(localFiles());
      return xhrSend({
        method: 'GET',
        url: String(c.url).replace(/\/$/, '') + '/rest/v1/vault_files?select=*&order=createdAt.desc',
        headers: sbHeaders()
      }).then(function (rows) {
        if (Array.isArray(rows)) {
          saveLocalFiles(rows);
          return rows;
        }
        return localFiles();
      }).catch(function (e) {
        console.warn('[Terrarium] Kunde inte hämta metadata:', e.message);
        return localFiles();
      });
    },

    remove: function (meta) {
      var c = sbConfig();
      var baseUrl = String(c.url).replace(/\/$/, '');
      removeLocal(meta.id);
      var p1 = xhrSend({
        method: 'DELETE',
        url: baseUrl + '/storage/v1/object/' + encodeURIComponent(c.bucket || 'vault') + '/' + encPath(meta.path),
        headers: sbHeaders()
      }).catch(function () {});
      var p2 = c.syncMetadata
        ? xhrSend({
            method: 'DELETE',
            url: baseUrl + '/rest/v1/vault_files?id=eq.' + encodeURIComponent(meta.id),
            headers: sbHeaders()
          }).catch(function () {})
        : Promise.resolve();
      return Promise.all([p1, p2]);
    },

    getUrl: function (meta) { return Promise.resolve(meta.url || ''); }
  };

  /* ============================================================
     CLOUDINARY ADAPTER (unsigned upload)
     ============================================================ */
  function ccConfig() { return settings.cloudinary || {}; }

  var CloudinaryAdapter = {
    id: 'cloudinary',
    name: 'Cloudinary',
    canDelete: true, // appen gör mjuk radering till papperskorgen; permanent rensning sker explicit
    isDemo: false,

    init: function () {
      var c = ccConfig();
      if (!c.cloudName || !c.uploadPreset) {
        return Promise.reject(new Error('Cloudinary cloud name och upload preset saknas.'));
      }
      return Promise.resolve(true);
    },

    upload: function (file, onProgress, signal) {
      var c = ccConfig();
      var id = uid();
      var fd = new FormData();
      fd.append('file', file);
      fd.append('upload_preset', c.uploadPreset);
      fd.append('folder', c.folder || 'terrarium');
      fd.append('public_id', id + '-' + safeName(file.name).replace(/\.[^.]+$/, ''));
      fd.append('resource_type', 'auto');

      return xhrSend({
        method: 'POST',
        url: 'https://api.cloudinary.com/v1_1/' + encodeURIComponent(c.cloudName) + '/auto/upload',
        body: fd,
        onProgress: onProgress,
        signal: signal
      }).then(function (res) {
        if (!res || !res.secure_url) throw new Error('Cloudinary returnerade ingen URL.');
        var meta = {
          id: id,
          name: file.name,
          size: res.bytes || file.size,
          type: res.resource_type === 'image' ? (res.format ? 'image/' + res.format : file.type)
                : (file.type || 'application/octet-stream'),
          path: res.public_id || id,
          url: res.secure_url,
          createdAt: new Date().toISOString(),
          starred: false,
          tags: []
        };
        upsertLocal(meta);
        return meta;
      });
    },

    list: function () { return Promise.resolve(localFiles()); },

    remove: function (meta) {
      removeLocal(meta.id);
      return Promise.resolve(true);
    },

    getUrl: function (meta) { return Promise.resolve(meta.url || ''); }
  };

  /* ============================================================
     TMPFILES — gratis moln utan konto (publika länkar)
     ============================================================ */
  var TmpFilesAdapter = {
    id: 'tmpfiles',
    name: 'Gratis moln · TmpFiles',
    canDelete: true,
    isDemo: false,

    init: function () { return Promise.resolve(true); },

    upload: function (file, onProgress, signal) {
      var fd = new FormData();
      fd.append('file', file, file.name || 'fil');
      var onNetlify = typeof location !== 'undefined' && /netlify\.app$/i.test(location.hostname || '');
      var urls = [];
      if (onNetlify) urls.push('api/tmpfiles');
      urls.push('https://tmpfiles.org/api/v1/upload', 'https://tmpfiles.org/api/v1/upload');
      function attempt(i) {
        if (i >= urls.length) return Promise.reject(new Error('TmpFiles accepterade inte uppladdningen'));
        return xhrSend({ method: 'POST', url: urls[i], body: fd, onProgress: onProgress, signal: signal })
          .catch(function (e) {
            if (signal && signal.aborted) throw e;
            return attempt(i + 1);
          });
      }
      return attempt(0).then(function (res) {
        var shareUrl = res && res.data && res.data.url;
        if (!shareUrl) throw new Error('TmpFiles returnerade ingen länk');
        var direct = String(shareUrl).replace('https://tmpfiles.org/', 'https://tmpfiles.org/dl/');
        var meta = {
          id: uid(),
          name: file.name || 'fil',
          size: file.size,
          type: file.type || 'application/octet-stream',
          path: shareUrl,
          url: direct,
          createdAt: new Date().toISOString(),
          starred: false,
          tags: []
        };
        upsertLocal(meta);
        return meta;
      });
    },

    list: function () { return Promise.resolve(localFiles()); },

    remove: function (meta) {
      removeLocal(meta.id);
      return Promise.resolve(true);
    },

    getUrl: function (meta) { return Promise.resolve(meta.url || ''); }
  };

  /* ============================================================
     CATBOX — permanent gratislagring via same-origin proxy
     ============================================================ */
  var catboxReady = false;

  var CatboxAdapter = {
    id: 'catbox',
    name: 'Permanent gratis · Catbox',
    canDelete: true,
    isDemo: false,

    init: function () {
      if (catboxReady) return Promise.resolve(true);
      return checkCatbox().then(function (ok) {
        catboxReady = ok;
        return ok ? true : Promise.reject(new Error('Proxy till Catbox saknas'));
      });
    },

    upload: function (file, onProgress, signal) {
      var fd = new FormData();
      fd.append('reqtype', 'fileupload');
      fd.append('fileToUpload', file, file.name || 'fil');
      return xhrSend({
        method: 'POST',
        url: 'api/filehost',
        body: fd,
        onProgress: onProgress,
        signal: signal
      }).then(function (res) {
        var url = String(res || '').trim();
        if (!/^https?:\/\//i.test(url)) throw new Error('Catbox returnerade ingen länk');
        var meta = {
          id: uid(),
          name: file.name || 'fil',
          size: file.size,
          type: file.type || 'application/octet-stream',
          path: url,
          url: url,
          permanent: true,
          createdAt: new Date().toISOString(),
          starred: false,
          tags: []
        };
        upsertLocal(meta);
        return meta;
      });
    },

    list: function () { return Promise.resolve(localFiles()); },

    remove: function (meta) {
      removeLocal(meta.id);
      return Promise.resolve(true);
    },

    getUrl: function (meta) { return Promise.resolve(meta.url || ''); }
  };

  function checkCatbox() {
    var fd = new FormData();
    fd.append('reqtype', 'fileupload');
    fd.append('fileToUpload', new File(['ping'], 'ping.txt', { type: 'text/plain' }), 'ping.txt');
    return xhrSend({ method: 'POST', url: 'api/filehost', body: fd })
      .then(function (res) { catboxReady = /^https?:\/\//i.test(String(res || '').trim()); return catboxReady; })
      .catch(function () { catboxReady = false; return false; });
  }

  /* ============================================================
     PUBLIC API
     ============================================================ */
  var adapters = { local: LocalAdapter, supabase: SupabaseAdapter, cloudinary: CloudinaryAdapter, tmpfiles: TmpFilesAdapter, catbox: CatboxAdapter };

  var Store = {
    settings: settings,
    adapters: adapters,
    fmtBytes: fmtBytes,

    saveSettings: function (patch) {
      settings = merge(settings, patch || {});
      writeJSON(LS_SETTINGS, settings);
      Store.settings = settings;
      return settings;
    },

    resetSettings: function () {
      localStorage.removeItem(LS_SETTINGS);
      settings = merge(base, {});
      Store.settings = settings;
      return settings;
    },

    checkCatbox: checkCatbox,

    // Validera sparad konfiguration. Felaktiga/ofsäkrade nycklar ska aldrig
    // låsa användaren i ett läge där uppladdningar tyst misslyckas.
    // Testar en molnkonfiguration innan den sparas.
    testConnection: function (provider, config) {
      config = config || {};
      if (provider === 'tmpfiles') return Promise.resolve({ ok: true, text: 'TmpFiles behöver inget konto – klart.' });
      if (provider === 'catbox') {
        return checkCatbox().then(function (ok) {
          return ok ? { ok: true, text: 'Permanentlagring ansluten – filer stannar kvar.' }
                    : { ok: false, text: 'Proxy saknas. Publicera på Netlify med _redirects, eller använd TmpFiles.' };
        });
      }
      if (provider === 'cloudinary') {
        var c = config.cloudinary || {};
        if (!/^[a-z0-9_-]{2,}$/i.test(c.cloudName || '')) return Promise.resolve({ ok: false, text: 'Cloud name saknas eller är ogiltig.' });
        if (!(c.uploadPreset || '').trim()) return Promise.resolve({ ok: false, text: 'Upload preset saknas.' });
        return Promise.resolve({ ok: true, text: 'Cloudinary-konfigurationen ser giltig ut.' });
      }
      if (provider === 'supabase') {
        var s = config.supabase || {};
        if (!/^https?:\/\//i.test(s.url || '')) return Promise.resolve({ ok: false, text: 'Project URL saknas eller är ogiltig.' });
        if (!(s.anonKey || '').trim()) return Promise.resolve({ ok: false, text: 'Anon-nyckel saknas.' });
        return xhrSend({
          method: 'GET',
          url: String(s.url).replace(/\/$/, '') + '/rest/v1/vault_files?select=id&limit=1',
          headers: { apikey: s.anonKey, Authorization: 'Bearer ' + s.anonKey }
        }).then(function () {
          return { ok: true, text: 'Ansluten till Supabase.' };
        }).catch(function (e) {
          var msg = String(e.message || '');
          if (/404/.test(msg)) return { ok: true, text: 'Ansluten – kör SQL-filen för att skapa tabellen.' };
          return { ok: false, text: 'Kunde inte ansluta: ' + msg };
        });
      }
      return Promise.resolve({ ok: false, text: 'Okänd leverantör.' });
    },

    getAdapter: function () {
      var id = settings.provider || 'tmpfiles';
      if (id === 'supabase') {
        var s = settings.supabase || {};
        if (!/^https?:\/\//i.test(s.url || '') || !(s.anonKey || '').trim()) id = 'tmpfiles';
      }
      if (id === 'cloudinary') {
        var c = settings.cloudinary || {};
        if (!/^[a-z0-9_-]{2,}$/i.test(c.cloudName || '') || !(c.uploadPreset || '').trim()) id = 'tmpfiles';
      }
      if (id === 'catbox' && !catboxReady) id = 'tmpfiles';
      return adapters[id] || TmpFilesAdapter;
    },

    // Flytta metadata mellan adaptrar (t.ex. lokal demo -> moln)
    exportMetadata: function () {
      return JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), files: localFiles() }, null, 2);
    },

    importMetadata: function (json) {
      var data = JSON.parse(json);
      var incoming = Array.isArray(data) ? data : (data.files || []);
      var merged = localFiles().slice();
      incoming.forEach(function (f) {
        if (!f || !f.id) return;
        var i = merged.findIndex(function (x) { return x.id === f.id; });
        if (i >= 0) merged[i] = f; else merged.unshift(f);
      });
      saveLocalFiles(merged);
      return merged.length;
    },

    clearMetadata: function () { saveLocalFiles([]); },
    dropMeta: function (id) { removeLocal(id); },

    // Aktivitetshistorik – senaste 100 händelserna sparas lokalt.
    getActivity: function () { return readJSON(LS_ACTIVITY, []); },

    logActivity: function (action, detail) {
      var list = readJSON(LS_ACTIVITY, []);
      list.unshift({ id: uid(), action: action, detail: String(detail || ''), at: new Date().toISOString() });
      if (list.length > 100) list = list.slice(0, 100);
      writeJSON(LS_ACTIVITY, list);
      return list;
    },

    exportCSV: function () {
      var cols = ['id', 'name', 'size', 'type', 'path', 'url', 'createdAt', 'starred', 'pinned', 'folder', 'tags'];
      function cell(v) {
        var s = Array.isArray(v) ? v.join('; ') : (v == null ? '' : String(v));
        return '"' + s.replace(/"/g, '""') + '"';
      }
      var lines = [cols.join(',')];
      localFiles().forEach(function (f) { lines.push(cols.map(function (c) { return cell(f[c]); }).join(',')); });
      return '\ufeff' + lines.join('\r\n');
    },

    getAchievements: function () { return readJSON(LS_ACHIEVEMENTS, []); },

    unlockAchievement: function (id) {
      var list = readJSON(LS_ACHIEVEMENTS, []);
      if (list.indexOf(id) >= 0) return false;
      list.push(id);
      writeJSON(LS_ACHIEVEMENTS, list);
      return true;
    },

    /* Papperskorg – metadata flyttas, blobar och molnobjekt lämnas kvar
       tills användaren rensar dem permanent. */
    getTrash: function () { return readJSON(LS_TRASH, []); },

    softDelete: function (meta) {
      var list = readJSON(LS_TRASH, []);
      list.unshift({ id: meta.id, meta: meta, deletedAt: new Date().toISOString() });
      if (list.length > 50) list = list.slice(0, 50);
      writeJSON(LS_TRASH, list);
      removeLocal(meta.id);
      return list;
    },

    restoreFromTrash: function (id) {
      var list = readJSON(LS_TRASH, []);
      var item = list.find(function (t) { return t.id === id; });
      if (!item) return null;
      writeJSON(LS_TRASH, list.filter(function (t) { return t.id !== id; }));
      return upsertLocal(item.meta);
    },

    dropFromTrash: function (id) {
      var list = readJSON(LS_TRASH, []);
      writeJSON(LS_TRASH, list.filter(function (t) { return t.id !== id; }));
    },

    /* Egen bakgrundsbild sparas som blob i samma IndexedDB. */
    setWallpaperBlob: function (blob) { return idbPut('__wallpaper__', blob); },
    getWallpaperBlob: function () { return idbGet('__wallpaper__'); },
    deleteWallpaperBlob: function () { return idbDelete('__wallpaper__'); },

    // Används av backup-restore för att lägga tillbaka lokala filblobar.
    putFileBlob: function (id, blob) { return idbPut(id, blob); },
    getFileBlob: function (id) { return idbGet(id); },

    // Senaste kommandona i paletten.
    getRecentCommands: function () { return readJSON(LS_RECENT, []); },
    rememberCommand: function (name) {
      var list = readJSON(LS_RECENT, []).filter(function (x) { return x !== name; });
      list.unshift(name);
      writeJSON(LS_RECENT, list.slice(0, 6));
    },

    // Uppdatera en metadata-post (stjärnmärkning etc.) lokalt och i molnet.
    updateMeta: function (meta) {
      var prev = localFiles().find(function (f) { return f.id === meta.id; });
      if (prev) {
        var fields = ['name', 'tags', 'note', 'starred', 'pinned', 'folder', 'icon'];
        var changes = fields.filter(function (k) { return JSON.stringify(prev[k]) !== JSON.stringify(meta[k]); });
        if (changes.length) {
          var snapshot = { at: new Date().toISOString(), changes: changes, value: {} };
          changes.forEach(function (k) { snapshot.value[k] = prev[k]; });
          meta.versions = (prev.versions || []).slice(-19).concat([snapshot]);
        } else {
          meta.versions = prev.versions || [];
        }
      }
      upsertLocal(meta);
      var c = sbConfig();
      if (settings.provider === 'supabase' && c.syncMetadata && c.url && c.anonKey) {
        return xhrSend({
          method: 'PATCH',
          url: String(c.url).replace(/\/$/, '') + '/rest/v1/vault_files?id=eq.' + encodeURIComponent(meta.id),
          headers: sbHeaders({ 'Content-Type': 'application/json', 'Prefer': 'return=minimal' }),
          body: JSON.stringify({ name: meta.name, starred: !!meta.starred, pinned: !!meta.pinned, tags: meta.tags || [], folder: meta.folder || null, note: meta.note || '' })
        }).catch(function (e) { console.warn('[Terrarium] Uppdatering misslyckades:', e.message); });
      }
      return Promise.resolve(true);
    }
  };

  window.TerrariumStore = Store;
})();
