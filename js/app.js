/* ============================================================
   TERRARIUM 2.0 — UI, filhanterare, kommandopalett, PWA
   ============================================================ */
(function () {
  'use strict';

  var Store = window.TerrariumStore;
  if (!Store) {
    document.addEventListener('DOMContentLoaded', function () {
      document.body.insertAdjacentHTML('afterbegin',
        '<div style="padding:16px;background:#3a0d0d;color:#fff;font-family:monospace">Fel: storage.js kunde inte laddas.</div>');
    });
    return;
  }

  var settings = Store.settings;
  var brand = settings.brand || {};
  var theme = settings.theme || { accent: 'lime', wallpaper: true, motion: true, view: 'grid' };

  var state = {
    files: [],
    filter: 'all',
    query: '',
    sort: 'newest',
    view: theme.view || 'grid',
    collection: { type: 'all', value: '' },
    zoom: 2,
    lastSelectIndex: null,
    bulkTagIds: [],
    selected: new Set(),
    queue: {},
    failed: {},
    cancelled: new Set(),
    queueToken: 0,
    previewId: null,
    paletteIndex: 0,
    paletteItems: [],
    installPrompt: null,
    ready: false,
    zen: false,
    wallpaperUrl: null,
    slideTimer: null,
    wallpaperTimer: null,
    ambient: null,
    cleanupIds: [],
    qrUrl: '',
    contentMatches: null,
    contentToken: 0,
    dragFileId: null
  };

  var $ = function (s, root) { return (root || document).querySelector(s); };
  var $$ = function (s, root) { return Array.prototype.slice.call((root || document).querySelectorAll(s)); };

  function icon(name, cls) {
    return '<svg class="ic ' + (cls || '') + '" aria-hidden="true"><use href="#ic-' + name + '"></use></svg>';
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function uidLocal() { return 'q' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function debounce(fn, ms) { var t; return function () { clearTimeout(t); var a = arguments; t = setTimeout(function () { fn.apply(null, a); }, ms); }; }

  function fuzzyMatch(text, q) {
    var i = 0, s = String(text || '').toLowerCase();
    for (var j = 0; j < s.length && i < q.length; j++) if (s[j] === q[i]) i++;
    return i === q.length;
  }

  /* Smarta sökoperatorer: tag: folder: type: starred size:>1mb */
  function sizeToBytes(str) {
    var m = String(str).match(/^([<>]=?|=)?\s*(\d+(?:\.\d+)?)\s*(kb|mb|gb|b)?$/i);
    if (!m) return null;
    var mult = { b: 1, kb: 1024, mb: 1048576, gb: 1073741824 }[(m[3] || 'b').toLowerCase()];
    return { op: m[1] || '>=', bytes: parseFloat(m[2]) * mult };
  }

  function parseQuery(raw) {
    var q = { text: [], tags: [], folders: [], type: null, starred: false, size: null, ext: '', content: null };
    String(raw || '').trim().split(/\s+/).forEach(function (token) {
      if (!token) return;
      var low = token.toLowerCase();
      if (low.indexOf('tag:') === 0) { q.tags.push(low.slice(4).replace(/^#/, '')); return; }
      if (low.indexOf('folder:') === 0) { q.folders.push(low.slice(7)); return; }
      if (low.indexOf('type:') === 0) { q.type = low.slice(5); return; }
      if (low === 'starred' || low === 'stjärna') { q.starred = true; return; }
      if (low.indexOf('size:') === 0) { q.size = sizeToBytes(low.slice(5)); return; }
      if (low.indexOf('ext:') === 0) { q.ext = low.slice(4); return; }
      if (low.indexOf('content:') === 0) { q.content = low.slice(8); return; }
      q.text.push(low);
    });
    return q;
  }

  /* ---------- Sökrelevans: fuzCSS + editdistans ---------- */
  function levenshtein(a, b) {
    if (a === b) return 0;
    var prev = [];
    for (var j = 0; j <= b.length; j++) prev[j] = j;
    for (var i = 1; i <= a.length; i++) {
      var cur = [i];
      for (var j = 1; j <= b.length; j++) {
        var cost = a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1;
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      }
      prev = cur;
    }
    return prev[b.length];
  }

  // 0 = ingen match. Jo högre så bättre relevans.
  function fuzzyScore(a, b) {
    a = String(a || '').toLowerCase();
    b = String(b || '').toLowerCase();
    if (!a || !b) return 0;
    var idx = a.indexOf(b);
    if (idx >= 0) return 1000 + (a.length - idx) + b.length * 10; // exakt träff
    if (b.length >= 3 && a.length >= 2 && levenshtein(a, b) <= 2) return 500 + b.length; // nästan-exakt
    // Subsekvens: alla frågeorder förekommer i namnet men kan ha övriga tecken mellan.
    var pi = 0;
    for (var i = 0; i < a.length && pi < b.length; i++) if (a.charAt(i) === b.charAt(pi)) pi++;
    return pi === b.length ? 200 - levenshtein(a, b) : 0;
  }

  function searchScore(f, q) {
    if (!q.text.length) return 1;
    var best = 0;
    q.text.forEach(function (t) {
      best = Math.max(best,
        fuzzyScore(f.name, t),
        fuzzyScore(f.folder, t),
        fuzzyScore(String(f.tags || []).join(' '), t));
    });
    return best;
  }

  function runContentSearch(term) {
    var token = ++state.contentToken;
    state.contentMatches = null;
    renderFiles();
    var candidates = state.files.filter(function (f) {
      var c = category(f.type, f.name);
      return (c === 'code' || c === 'doc') && (Number(f.size) || 0) < 5 * 1048576;
    });
    if (!candidates.length || !term) {
      state.contentMatches = new Set();
      renderFiles();
      return;
    }
    Promise.all(candidates.map(function (f) {
      function test(text) { return text.toLowerCase().indexOf(term.toLowerCase()) >= 0 ? f.id : null; }
      return Store.getFileBlob(f.id).then(function (blob) {
        if (blob) return blob.text();
        return Store.getAdapter().getUrl(f).then(function (url) {
          return fetch(url, { cache: 'no-store' }).then(function (r) { return r.text(); });
        });
      }).then(test).catch(function () { return null; });
    })).then(function (ids) {
      if (token !== state.contentToken) return;
      state.contentMatches = new Set(ids.filter(Boolean));
      renderFiles();
      toast(state.contentMatches.size + ' fil(er) innehåller "' + term + '"');
    });
  }

  function matchesQuery(f, q) {
    if (q.text.length && !q.text.every(function (t) {
      return fuzzyScore(f.name, t) > 0 || fuzzyScore(f.folder, t) > 0 || fuzzyScore(String(f.tags || []).join(' '), t) > 0;
    })) return false;
    if (q.ext && String(f.name || '').toLowerCase().indexOf(q.ext.toLowerCase()) < 0) return false;
    if (q.content && (!state.contentMatches || !state.contentMatches.has(f.id))) return false;
    if (q.starred && !f.starred) return false;
    if (q.type && category(f.type, f.name) !== q.type && String(f.type || '').toLowerCase().indexOf(q.type) < 0) return false;
    if (q.tags.length && !q.tags.every(function (t) { return (f.tags || []).some(function (x) { return String(x).toLowerCase().indexOf(t) >= 0; }); })) return false;
    if (q.folders.length && !q.folders.some(function (p) { return String(f.folder || '').toLowerCase().indexOf(p) >= 0; })) return false;
    if (q.size) {
      var s = Number(f.size) || 0, op = q.size.op, b = q.size.bytes;
      if (op === '>' && !(s > b)) return false;
      if (op === '<' && !(s < b)) return false;
      if (op === '=' && Math.abs(s - b) > 1) return false;
      if (op === '>=' && !(s >= b)) return false;
      if (op === '<=' && !(s <= b)) return false;
    }
    return true;
  }

  function duplicateKey(f) {
    return String(f.name || '').toLowerCase() + '|' + (Number(f.size) || 0);
  }

  function isDuplicate(f) {
    var key = duplicateKey(f);
    return state.files.filter(function (x) { return duplicateKey(x) === key; }).length > 1;
  }

  function tagColor(tag) {
    var custom = (settings.tagColors || {})[tag];
    if (custom) return custom;
    var h = 0;
    String(tag).split('').forEach(function (c) { h = (h * 31 + c.charCodeAt(0)) % 360; });
    return 'hsl(' + h + ',85%,72%)';
  }

  function renderMarkdown(src) {
    var lines = String(src).split(/\r?\n/);
    var html = [], inCode = false;
    lines.forEach(function (line) {
      if (/^\s*```/.test(line)) { html.push(inCode ? '</code></pre>' : '<pre class="md-code"><code>'); inCode = !inCode; return; }
      if (inCode) { html.push(esc(line) + '\n'); return; }
      var l = esc(line);
      if (/^### /.test(l)) html.push('<h4>' + l.slice(4) + '</h4>');
      else if (/^## /.test(l)) html.push('<h3>' + l.slice(3) + '</h3>');
      else if (/^# /.test(l)) html.push('<h2>' + l.slice(2) + '</h2>');
      else if (/^[-*] /.test(l)) html.push('<li>' + l.slice(2) + '</li>');
      else if (/^\d+\. /.test(l)) html.push('<li>' + l.replace(/^\d+\. /, '') + '</li>');
      else if (!l.trim()) html.push('<br>');
      else html.push('<p>' + l.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/`([^`]+)`/g, '<code>$1</code>') + '</p>');
    });
    if (inCode) html.push('</code></pre>');
    return html.join('');
  }

  function suggestTags(f) {
    var out = [], n = String(f.name || '').toLowerCase(), c = category(f.type, f.name);
    if (c === 'image') out.push('bilder');
    if (c === 'video') out.push('video');
    if (c === 'audio') out.push('ljud');
    if (c === 'code') out.push('kod');
    if (c === 'doc') out.push('dokument');
    if (c === 'archive') out.push('arkiv');
    if (/screen|skärm|shot|capture/.test(n)) out.push('skärmdump');
    if (/rapport|report/.test(n)) out.push('rapport');
    if (/backup|säkerhet/.test(n)) out.push('backup');
    var year = new Date(f.createdAt).getFullYear();
    if (year) out.push(String(year));
    return out.filter(function (t, i) { return out.indexOf(t) === i; });
  }

  function autoTagAll() {
    if (!state.files.length) { toast('Inga filer att tagga', 'err'); return; }
    var total = 0;
    state.files.forEach(function (f) {
      var tags = (f.tags || []).slice();
      suggestTags(f).forEach(function (t) {
        if (tags.indexOf(t) < 0) { tags.push(t); total++; }
      });
      if (tags.length !== (f.tags || []).length) {
        f.tags = tags;
        Store.updateMeta(f);
      }
    });
    renderFiles();
    toast(total ? total + ' taggar tillagda automatiskt 🏷️' : 'Alla filer var redan taggade');
    Store.logActivity('tags', 'auto: ' + total + ' taggar');
  }

  function category(type, name) {
    var t = String(type || '').toLowerCase();
    var n = String(name || '').toLowerCase();
    if (t.indexOf('image/') === 0 || /\.(png|jpe?g|gif|webp|svg|avif|heic)$/.test(n)) return 'image';
    if (t.indexOf('video/') === 0 || /\.(mp4|mov|webm|mkv|avi)$/.test(n)) return 'video';
    if (t.indexOf('audio/') === 0 || /\.(mp3|wav|ogg|m4a|flac)$/.test(n)) return 'audio';
    if (/\.(zip|rar|7z|tar|gz)$/.test(n) || t.indexOf('zip') >= 0) return 'archive';
    if (/\.(js|ts|jsx|tsx|html|css|json|md|py|rs|go|java|swift|kt|sh|yml|yaml|xml)$/.test(n)) return 'code';
    if (/\.(pdf|doc|docx|txt|rtf|xls|xlsx|ppt|pptx|csv)$/.test(n) || t.indexOf('pdf') >= 0) return 'doc';
    return 'other';
  }
  var CAT_LABEL = { all: 'Alla', image: 'Bilder', video: 'Video', audio: 'Ljud', archive: 'Arkiv', code: 'Kod', doc: 'Dokument', other: 'Övrigt', starred: 'Stjärnor' };
  var CAT_ICON = { image: 'image', video: 'video', audio: 'music', archive: 'archive', code: 'code', doc: 'file', other: 'file' };
  var LEVELS = ['Ägg', 'Baby Gecko', 'Terrariepionjär', 'Swamp Ranger', 'Lizard Legend', 'Kronreptil', '230-Sage', 'Canopy God'];

  /* ---------------- Toast ---------------- */
  function toast(msg, kind) {
    var wrap = $('#toasts');
    if (!wrap) return;
    var el = document.createElement('div');
    el.className = 'toast ' + (kind || 'ok');
    el.innerHTML = icon(kind === 'err' ? 'alert' : 'check') + '<span>' + esc(msg) + '</span>';
    wrap.appendChild(el);
    requestAnimationFrame(function () { el.classList.add('in'); });
    setTimeout(function () {
      el.classList.remove('in');
      setTimeout(function () { el.remove(); }, 320);
    }, 3200);
  }

  /* ---------------- Modal ---------------- */
  function openModal(id) {
    var m = $('#' + id);
    if (!m) return;
    m.classList.add('open');
    m.setAttribute('aria-hidden', 'false');
    var f = m.querySelector('input:not([type=hidden]), button');
    if (f) setTimeout(function () { try { f.focus(); } catch (e) {} }, 60);
  }
  function closeModal(id) {
    var m = $('#' + id);
    if (!m) return;
    m.classList.remove('open');
    m.setAttribute('aria-hidden', 'true');
    if (id === 'previewModal') {
      state.previewId = null;
      if (state.slideTimer) { clearInterval(state.slideTimer); state.slideTimer = null; }
      if (document.fullscreenElement) document.exitFullscreen().catch(function () {});
    }
  }
  function closeAllModals() { $$('.modal.open').forEach(function (m) { closeModal(m.id); }); }

  /* ---------------- Tema ---------------- */
  function hexToRgb(hex) {
    var h = String(hex || '').replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    if (!/^[0-9a-f]{6}$/i.test(h)) return null;
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }

  function applyTheme() {
    var root = document.documentElement;
    root.setAttribute('data-accent', theme.accent || 'lime');
    var rgb = theme.useCustom ? hexToRgb(theme.customAccent) : null;
    if (rgb) {
      var light = rgb.map(function (c) { return Math.round(c + (255 - c) * 0.3); });
      var dark = rgb.map(function (c) { return Math.round(c * 0.12); });
      var css = root.style;
      css.setProperty('--accent', 'rgb(' + rgb.join(',') + ')');
      css.setProperty('--accent-2', 'rgb(' + light.join(',') + ')');
      css.setProperty('--accent-rgb', rgb.join(','));
      css.setProperty('--accent-dark', 'rgb(' + dark.join(',') + ')');
    } else {
      ['--accent', '--accent-2', '--accent-rgb', '--accent-dark'].forEach(function (k) { root.style.removeProperty(k); });
    }
    document.body.dataset.wallpaper = theme.wallpaperStyle || 'jungle';
    document.body.classList.toggle('no-wallpaper', theme.wallpaper === false);
    document.body.classList.toggle('no-motion', theme.motion === false);
  }

  function applyWallpaper() {
    var el = $('.wallpaper');
    if (!el) return;
    if (state.wallpaperUrl) { URL.revokeObjectURL(state.wallpaperUrl); state.wallpaperUrl = null; }
    if (!theme.customWallpaper) { el.style.removeProperty('background-image'); return; }
    Store.getWallpaperBlob().then(function (blob) {
      if (!blob || !theme.customWallpaper) { el.style.removeProperty('background-image'); return; }
      state.wallpaperUrl = URL.createObjectURL(blob);
      el.style.backgroundImage = 'url("' + state.wallpaperUrl + '")';
    }).catch(function () { el.style.removeProperty('background-image'); });
  }

  function toggleAmbient(force) {
    var want = typeof force === 'boolean' ? force : !state.ambient;
    if (want) {
      if (!state.ambient) {
        try {
          var Ctx = window.AudioContext || window.webkitAudioContext;
          if (!Ctx) throw new Error('WebAudio stöds inte');
          var ctx = new Ctx();
          var master = ctx.createGain();
          master.gain.value = 0.035;
          master.connect(ctx.destination);
          var filter = ctx.createBiquadFilter();
          filter.type = 'lowpass';
          filter.frequency.value = 420;
          filter.connect(master);
          var nodes = [];
          [110, 164.81, 220].forEach(function (freq, i) {
            var o = ctx.createOscillator();
            o.type = i === 2 ? 'triangle' : 'sine';
            o.frequency.value = freq;
            var g = ctx.createGain();
            g.gain.value = i === 2 ? 0.25 : 0.5;
            o.connect(g); g.connect(filter); o.start();
            nodes.push(o);
          });
          var lfo = ctx.createOscillator();
          lfo.frequency.value = 0.08;
          var lg = ctx.createGain();
          lg.gain.value = 90;
          lfo.connect(lg); lg.connect(filter.frequency); lfo.start();
          nodes.push(lfo);
          state.ambient = { ctx: ctx, nodes: nodes };
        } catch (e) {
          toast('Ljud kunde inte starta: ' + e.message, 'err');
          return false;
        }
      }
      if (state.ambient.ctx.state === 'suspended') state.ambient.ctx.resume();
      theme.ambient = true;
      Store.saveSettings({ theme: { ambient: true } });
      settings = Store.settings; theme = settings.theme;
      toast('Ambient-ljud på 🎧');
    } else {
      if (state.ambient) {
        state.ambient.nodes.forEach(function (o) { try { o.stop(); } catch (e) {} });
        state.ambient.ctx.close();
        state.ambient = null;
      }
      theme.ambient = false;
      Store.saveSettings({ theme: { ambient: false } });
      settings = Store.settings; theme = settings.theme;
      toast('Ambient-ljud av');
    }
    var btn = $('#ambientBtn');
    if (btn) btn.classList.toggle('active', !!state.ambient);
    return want;
  }

  function applyWallpaperRotation() {
    if (state.wallpaperTimer) { clearInterval(state.wallpaperTimer); state.wallpaperTimer = null; }
    if (!theme.rotateWallpapers || theme.customWallpaper) return;
    state.wallpaperTimer = setInterval(function () {
      var styles = ['jungle', 'night', 'amber'];
      var i = styles.indexOf(theme.wallpaperStyle || 'jungle');
      theme.wallpaperStyle = styles[(i + 1) % styles.length];
      Store.saveSettings({ theme: { wallpaperStyle: theme.wallpaperStyle } });
      settings = Store.settings; theme = settings.theme;
      applyTheme(); fillSettingsForm();
    }, 30000);
  }

  function applyBrand() {
    document.title = (brand.name || 'THE TERRARIUM') + ' — ' + (brand.tagline || 'Din gröna drop');
    $$('[data-brand]').forEach(function (el) { el.textContent = brand.name || 'THE TERRARIUM'; });
    $$('[data-owner]').forEach(function (el) { el.textContent = brand.owner || ''; });
    $$('[data-tagline]').forEach(function (el) { el.textContent = brand.tagline || ''; });
  }

  function renderProvider() {
    var adapter = Store.getAdapter();
    var chip = $('#providerChip');
    if (chip) {
      chip.innerHTML = icon(adapter.isDemo ? 'flask' : 'cloud') + '<span>' + esc(adapter.name) + '</span>';
      chip.classList.toggle('demo', !!adapter.isDemo);
    }
    var banner = $('#demoBanner');
    if (banner) banner.hidden = !adapter.isDemo;
    var note = $('#cloudinaryNote');
    if (note) note.hidden = adapter.id !== 'cloudinary';
    var tmpNote = $('#tmpfilesNote');
    if (tmpNote) tmpNote.hidden = adapter.id !== 'tmpfiles';
    var catNote = $('#catboxNote');
    if (catNote) catNote.hidden = adapter.id !== 'catbox';
    var fallback = $('#fallbackBanner');
    var requested = settings.provider || 'tmpfiles';
    if (fallback) fallback.hidden = !(requested !== adapter.id && requested !== 'local');
    var upgrade = $('#upgradeBanner');
    if (upgrade) upgrade.hidden = adapter.id !== 'tmpfiles';
  }

  /* ---------------- Samlingar ---------------- */
  function collButton(type, value, ico, label, count, color) {
    var active = state.collection.type === type && state.collection.value === value;
    var style = color ? ' style="color:' + color + '"' : '';
    return '<button class="coll-item ' + (active ? 'active' : '') + '" data-collection="' + esc(type) + '" data-value="' + esc(value) + '">' +
      icon(ico) + '<span class="coll-name"' + style + '>' + esc(label) + '</span><span class="pill">' + count + '</span></button>';
  }

  function renderCollections() {
    var wrap = $('#collectionList');
    if (!wrap) return;
    var files = state.files;
    var week = Date.now() - 7 * 86400000;
    var recent = files.filter(function (f) { return new Date(f.createdAt).getTime() > week; }).length;
    var folders = {}, tags = {};
    files.forEach(function (f) {
      if (f.folder) folders[f.folder] = (folders[f.folder] || 0) + 1;
      (f.tags || []).forEach(function (t) { tags[t] = (tags[t] || 0) + 1; });
    });
    var html = '<div class="coll-group">Grund</div>' +
      collButton('all', '', 'files', 'Alla filer', files.length) +
      collButton('starred', '', 'star', 'Stjärnmärkta', files.filter(function (f) { return f.starred; }).length) +
      collButton('pinned', '', 'pin', 'Fästa', files.filter(function (f) { return f.pinned; }).length) +
      collButton('recent', '', 'activity', 'Senaste 7 dagarna', recent) +
      collButton('duplicates', '', 'copy', 'Dubletter', files.filter(isDuplicate).length);
    var folderKeys = Object.keys(folders).sort();
    if (folderKeys.length) {
      html += '<div class="coll-group">Mappar</div>';
      html += folderKeys.map(function (k) { return collButton('folder', k, 'folder', k, folders[k]); }).join('');
    }
    var tagKeys = Object.keys(tags).sort();
    if (tagKeys.length) {
      html += '<div class="coll-group">Taggar</div>';
      html += tagKeys.map(function (k) { return collButton('tag', k, 'sparkle', '#' + k, tags[k], tagColor(k)); }).join('');
    }
    if (folderKeys.length === 0 && tagKeys.length === 0) {
      html += '<div class="coll-group">Taggar & mappar</div><div class="collection-empty">Dyk upp när du taggar filer eller laddar upp mappar 🌱</div>';
    }
    wrap.innerHTML = html;
  }

  /* ---------------- Aktivitet ---------------- */
  function relTime(iso) {
    var diff = Date.now() - new Date(iso).getTime();
    var min = Math.floor(diff / 60000);
    if (min < 1) return 'just nu';
    if (min < 60) return min + ' min sedan';
    var h = Math.floor(min / 60);
    if (h < 24) return h + ' tim sedan';
    var d = Math.floor(h / 24);
    if (d < 7) return d + ' dagar sedan';
    try { return new Date(iso).toLocaleDateString('sv-SE'); } catch (e) { return ''; }
  }

  function renderActivity() {
    var wrap = $('#activityList');
    if (!wrap) return;
    var list = Store.getActivity();
    if (!list.length) {
      wrap.innerHTML = '<div class="empty"><div class="empty-ic">📜</div><h3>Ingen historik ännu</h3><p>Dina åtgärder dyker upp här.</p></div>';
      return;
    }
    var icos = { upload: 'upload', delete: 'trash', purge: 'trash', restore: 'undo', rename: 'edit', star: 'star', pin: 'pin', tags: 'sparkle', settings: 'settings', import: 'download', zip: 'archive', backup: 'archive', 'restore-backup': 'undo', slideshow: 'image', folder: 'folder', sharepage: 'link', renew: 'undo' };
    wrap.innerHTML = list.map(function (a) {
      var del = a.action === 'delete';
      return '<div class="tl-row"><div class="tl-ic ' + (del ? 'del' : '') + '">' + icon(icos[a.action] || 'activity') + '</div>' +
        '<div><div class="tl-text">' + esc(a.action) + '</div><div class="tl-detail">' + esc(a.detail) + '</div></div>' +
        '<div class="tl-time">' + esc(relTime(a.at)) + '</div></div>';
    }).join('');
    var dot = $('#activityDot');
    if (dot) dot.hidden = true;
  }

  /* ---------------- Insikter ---------------- */
  function renderInsights() {
    var body = $('#insightsBody');
    if (!body) return;
    var files = state.files;
    var bytes = files.reduce(function (a, f) { return a + (Number(f.size) || 0); }, 0);
    var sizes = {}, tagCounts = {}, folders = {};
    files.forEach(function (f) {
      var c = category(f.type, f.name);
      sizes[c] = (sizes[c] || 0) + (Number(f.size) || 0);
      if (f.folder) folders[f.folder] = 1;
      (f.tags || []).forEach(function (t) { tagCounts[t] = (tagCounts[t] || 0) + 1; });
    });
    var colors = { image: '#9bff5a', video: '#a084ff', audio: '#ffb347', code: '#8affc1', doc: '#6fd3ff', archive: '#ff8f6b', other: '#7f9c87' };
    var keys = Object.keys(sizes).filter(function (k) { return sizes[k] > 0; }).sort(function (a, b) { return sizes[b] - sizes[a]; });
    var total = keys.reduce(function (a, k) { return a + sizes[k]; }, 0) || 1;
    var circ = 2 * Math.PI * 52, cum = 0;
    var circles = keys.map(function (k) {
      var pct = sizes[k] / total;
      var el = '<circle cx="70" cy="70" r="52" stroke="' + colors[k] + '" stroke-dasharray="' +
        (pct * circ).toFixed(2) + ' ' + circ.toFixed(2) + '" stroke-dashoffset="' + (-cum * circ).toFixed(2) + '"></circle>';
      cum += pct;
      return el;
    }).join('');
    var legend = keys.map(function (k) {
      return '<span><i style="background:' + colors[k] + '"></i>' + CAT_LABEL[k] + ' · ' + Math.round(sizes[k] / total * 100) + '%</span>';
    }).join('') || '<span>Inga filer ännu</span>';
    var donut = '<div class="donut-wrap"><svg class="donut" viewBox="0 0 140 140"><circle class="track" cx="70" cy="70" r="52"></circle>' +
      circles + '</svg><div class="donut-legend">' + legend + '</div></div>';

    var days = [];
    for (var i = 6; i >= 0; i--) {
      var d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - i);
      var key = d.toISOString().slice(0, 10);
      var n = Store.getActivity().filter(function (a) { return a.action === 'upload' && String(a.at).slice(0, 10) === key; }).length;
      days.push({ label: d.toLocaleDateString('sv-SE', { weekday: 'short' }).slice(0, 2), n: n });
    }
    var max = Math.max.apply(null, days.map(function (d) { return d.n; }).concat([1]));
    var bars = days.map(function (d) {
      return '<div class="bar-col"><b>' + (d.n || '') + '</b><i style="height:' + (d.n / max * 80) + 'px"></i><span>' + esc(d.label) + '</span></div>';
    }).join('');

    var topTags = Object.keys(tagCounts).sort(function (a, b) { return tagCounts[b] - tagCounts[a]; }).slice(0, 8);

    // Trend: uppladdningar per dag de senaste 30 dagarna.
    var act = Store.getActivity();
    var trend = [];
    for (var t = 29; t >= 0; t--) {
      var d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - t);
      var key = d.toISOString().slice(0, 10);
      trend.push(act.filter(function (a) { return a.action === 'upload' && String(a.at).slice(0, 10) === key; }).length);
    }
    var maxT = Math.max.apply(null, trend.concat([1]));
    var trendBars = trend.map(function (n) {
      return '<div class="trend-col"><i style="height:' + (n / maxT * 80) + 'px"></i><span>' + n + '</span></div>';
    }).join('');

    body.innerHTML =
      '<div class="insight-nums" style="margin-bottom:18px">' +
        '<div class="insight-num"><b>' + files.length + '</b><span>FILER</span></div>' +
        '<div class="insight-num"><b>' + esc(Store.fmtBytes(bytes)) + '</b><span>LAGRING</span></div>' +
        '<div class="insight-num"><b>' + files.filter(function (f) { return f.pinned; }).length + '</b><span>FÄSTA</span></div>' +
      '</div>' +
      '<div class="insight-grid">' +
        '<div class="insight-card"><h3>Lagring per typ</h3>' + donut + '</div>' +
        '<div class="insight-card"><h3>Uppladdningar · 7 dagar</h3><div class="bars">' + bars + '</div></div>' +
        '<div class="insight-card"><h3>Uppladdningstrend (30 dagar)</h3><div class="trend-bars">' + trendBars + '</div></div>' +
      '</div>' +
      '<div class="insight-card" style="margin-top:18px"><h3>Populära taggar</h3><div class="top-tags">' +
        (topTags.length ? topTags.map(function (t) { return '<span>#' + esc(t) + ' · ' + tagCounts[t] + '</span>'; }).join('') : '<span>Inga taggar ännu</span>') +
      '</div></div>';

    if (navigator.storage && navigator.storage.estimate) {
      navigator.storage.estimate().then(function (est) {
        var wrap = $('#quotaWrap');
        if (!wrap) return;
        var used = est.usage || 0, quota = est.quota || 1;
        var pct = Math.max(1, Math.min(100, used / quota * 100));
        wrap.innerHTML = '<div class="quota"><div class="quota-head"><span>Lokalt utrymme i webbläsaren</span><span>' +
          Store.fmtBytes(used) + ' / ' + Store.fmtBytes(quota) + '</span></div>' +
          '<div class="quota-track"><i style="width:' + pct.toFixed(2) + '%"></i></div></div>';
      }).catch(function () {});
    }

    var activity = Store.getActivity();
    var days = [], max = 1;
    for (var d = 29; d >= 0; d--) {
      var date = new Date(); date.setHours(0, 0, 0, 0); date.setDate(date.getDate() - d);
      var key = date.toISOString().slice(0, 10);
      var n = activity.filter(function (a) { return String(a.at).slice(0, 10) === key; }).length;
      max = Math.max(max, n);
      days.push({ key: key, n: n, label: date.toLocaleDateString('sv-SE', { day: 'numeric', month: 'short' }) });
    }
    var heat = $('#heatmapWrap');
    if (heat) heat.innerHTML = '<div class="heatmap"><div class="heatmap-head"><span>Aktivitet · 30 dagar</span><span>' +
      activity.length + ' händelser</span></div><div class="heatmap-grid">' +
      days.map(function (x) {
        var alpha = x.n ? (0.15 + 0.85 * (x.n / max)).toFixed(2) : '0.04';
        return '<i class="heatmap-cell" data-n="' + x.n + '" title="' + esc(x.label) + ': ' + x.n + '" style="background:rgba(var(--accent-rgb),' + alpha + ')"></i>';
      }).join('') + '</div></div>';
    renderSystemStatus();
  }

  function renderSystemStatus() {
    var wrap = $('#statusWrap');
    if (!wrap) return;
    var adapter = Store.getAdapter();
    var shared = Store.settings.provider === 'supabase' && Store.settings.supabase.syncMetadata;
    var permanent = adapter.id === 'catbox' || adapter.id === 'supabase' || adapter.id === 'cloudinary';
    var backup = Store.getActivity().find(function (a) { return a.action === 'backup'; });
    var queued = Object.keys(state.queue).filter(function (k) { return state.queue[k].status === 'paused' || state.queue[k].status === 'error'; }).length;
    var rows = [
      ['Lagringsleverantör', adapter.name, ''],
      ['Länkar', permanent ? 'Permanenta' : 'Tillfälliga', permanent ? '' : 'warn'],
      ['Filista', shared ? 'Delad (Supabase)' : 'Endast denna webbläsare', shared ? '' : 'warn'],
      ['Anslutning', navigator.onLine ? 'Online' : 'Offline', navigator.onLine ? '' : 'off'],
      ['Väntande uppladdningar', String(queued), queued ? 'warn' : ''],
      ['Senaste backup', backup ? relTime(backup.at) : 'Aldrig', backup ? '' : 'warn']
    ];
    wrap.innerHTML = '<div class="status-panel"><h3>Systemstatus</h3>' + rows.map(function (r) {
      return '<div class="status-row"><i class="status-dot ' + r[2] + '"></i><span>' + esc(r[0]) + '</span><b>' + esc(r[1]) + '</b></div>';
    }).join('') + '</div>';
  }

  /* ---------------- Utmärkelser ---------------- */
  var BADGES = [
    { id: 'first', icon: '📦', name: 'Första skottet', desc: 'Ladda upp din första fil', test: function (c) { return c.files >= 1; } },
    { id: 'ten', icon: '🍄', name: 'Svampodlare', desc: 'Samla 10 filer', test: function (c) { return c.files >= 10; } },
    { id: 'twentyfive', icon: '🌳', name: 'Skogsvaktare', desc: 'Samla 25 filer', test: function (c) { return c.files >= 25; } },
    { id: 'tagger', icon: '🏷️', name: 'Etikettmästare', desc: 'Använd 5 olika taggar', test: function (c) { return c.tags >= 5; } },
    { id: 'cloud', icon: '☁️', name: 'Molnflirt', desc: 'Anslut ett gratis moln', test: function (c) { return c.provider !== 'local'; } },
    { id: 'zipper', icon: '🗜️', name: 'Packmästare', desc: 'Exportera en ZIP', test: function (c) { return c.zip; } },
    { id: 'collector', icon: '🗂️', name: 'Samlare', desc: 'Ha 3 mappar eller taggar', test: function (c) { return c.folders + c.tags >= 3; } },
    { id: 'streak', icon: '🔥', name: 'Tre dagars svärm', desc: 'Ladda upp under 3 dagar', test: function (c) { return c.uploadDays >= 3; } },
    { id: 'colorist', icon: '🎨', name: 'Färgtok', desc: 'Välj en egen accentfärg', test: function (c) { return c.custom; } },
    { id: 'historian', icon: '📜', name: 'Krönikör', desc: '50 händelser i historiken', test: function (c) { return c.activity >= 50; } },
    { id: 'star', icon: '⭐', name: 'Stjärnfall', desc: 'Stjärnmärk 5 filer', test: function (c) { return c.starred >= 5; } },
    { id: 'pin', icon: '📌', name: 'Fäst minne', desc: 'Fäst 3 filer', test: function (c) { return c.pinned >= 3; } },
    { id: 'zen', icon: '🧘', name: 'Zenmästare', desc: 'Aktivera zen-läge', test: function (c) { return c.zen; } },
    { id: 'resurrect', icon: '🔄', name: 'Återupplivare', desc: 'Återställ en fil ur papperskorgen', test: function (c) { return c.restored >= 1; } },
    { id: 'detective', icon: '🔍', name: 'Dubbelspår', desc: 'Upptäck ett dublett-par', test: function (c) { return c.duplicates >= 1; } },
    { id: 'backup', icon: '💾', name: 'Säkerhetsmedveten', desc: 'Skapa en full backup', test: function (c) { return c.backup; } },
    { id: 'director', icon: '🎬', name: 'Regissör', desc: 'Starta ett slideshow', test: function (c) { return c.slideshow; } }
  ];

  function badgeContext() {
    var files = state.files, tags = {}, folders = {}, days = {};
    files.forEach(function (f) {
      (f.tags || []).forEach(function (t) { tags[t] = 1; });
      if (f.folder) folders[f.folder] = 1;
    });
    Store.getActivity().forEach(function (a) {
      if (a.action === 'upload') days[String(a.at).slice(0, 10)] = 1;
    });
    return {
      files: files.length, tags: Object.keys(tags).length, folders: Object.keys(folders).length,
      provider: Store.settings.provider, zip: Store.getActivity().some(function (a) { return a.action === 'zip'; }),
      uploadDays: Object.keys(days).length, custom: !!Store.settings.theme.useCustom,
      activity: Store.getActivity().length,
      starred: files.filter(function (f) { return f.starred; }).length,
      pinned: files.filter(function (f) { return f.pinned; }).length,
      zen: state.zen,
      restored: Store.getActivity().filter(function (a) { return a.action === 'restore'; }).length,
      duplicates: files.filter(isDuplicate).length,
      backup: Store.getActivity().some(function (a) { return a.action === 'backup'; }),
      slideshow: Store.getActivity().some(function (a) { return a.action === 'slideshow'; })
    };
  }

  function checkAchievements(silent) {
    var ctx = badgeContext(), unlocked = Store.getAchievements(), fresh = [];
    BADGES.forEach(function (b) {
      if (unlocked.indexOf(b.id) < 0 && b.test(ctx)) {
        Store.unlockAchievement(b.id);
        fresh.push(b);
      }
    });
    var dot = $('#achievementDot');
    if (dot) dot.hidden = Store.getAchievements().length === 0;
    if (!silent) fresh.slice(0, 2).forEach(function (b) { toast('🏆 ' + b.name + ' upplåst!'); });
    return fresh;
  }

  function renderAchievements() {
    var wrap = $('#achievementsList');
    if (!wrap) return;
    checkAchievements(true);
    var unlocked = Store.getAchievements();
    wrap.innerHTML = BADGES.map(function (b) {
      var on = unlocked.indexOf(b.id) >= 0;
      return '<div class="badge-card ' + (on ? 'unlocked' : '') + '">' +
        '<div class="badge-ic">' + b.icon + '</div>' +
        '<div class="badge-name">' + esc(b.name) + '</div>' +
        '<div class="badge-desc">' + esc(b.desc) + '</div>' +
        (on ? '<div class="badge-desc" style="color:var(--accent)">UPPLÅST</div>' : '<div class="badge-lock">' + icon('lock') + '</div>') +
      '</div>';
    }).join('');
  }

  /* ---------------- Städassistent ---------------- */
  function cleanupGroups() {
    var files = state.files;
    var groups = {};
    files.forEach(function (f) {
      var k = duplicateKey(f);
      (groups[k] = groups[k] || []).push(f);
    });
    var dupIds = Object.keys(groups).filter(function (k) { return groups[k].length > 1; })
      .reduce(function (a, k) { return a.concat(groups[k].map(function (f) { return f.id; })); }, []);
    var big = files.filter(function (f) { return (Number(f.size) || 0) > 10 * 1048576; });
    var year = Date.now() - 365 * 86400000;
    var old = files.filter(function (f) { return new Date(f.createdAt).getTime() < year; });
    var untagged = files.filter(function (f) { return !(f.tags || []).length; });
    return [
      { id: 'dups', icon: 'copy', name: 'Dubletter', desc: dupIds.length ? dupIds.length + ' filer med samma namn och storlek' : 'Inga dubletter hittades', ids: dupIds },
      { id: 'big', icon: 'database', name: 'Stora filer', desc: big.length ? big.length + ' filer över 10 MB' : 'Inga filer över 10 MB', ids: big.map(function (f) { return f.id; }) },
      { id: 'old', icon: 'activity', name: 'Gamla filer', desc: old.length ? old.length + ' filer äldre än ett år' : 'Inga filer äldre än ett år', ids: old.map(function (f) { return f.id; }) },
      { id: 'untagged', icon: 'sparkle', name: 'Otaggade', desc: untagged.length ? untagged.length + ' filer utan taggar' : 'Alla filer är taggade', ids: untagged.map(function (f) { return f.id; }) }
    ];
  }

  function renderCleanup() {
    var wrap = $('#cleanupList');
    if (!wrap) return;
    var groups = cleanupGroups();
    state.cleanupIds = [];
    wrap.innerHTML = groups.map(function (g) {
      state.cleanupIds = state.cleanupIds.concat(g.ids);
      return '<div class="tl-row"><div class="tl-ic">' + icon(g.icon) + '</div>' +
        '<div><div class="tl-text">' + esc(g.name) + '</div><div class="tl-detail">' + esc(g.desc) + '</div></div>' +
        '<div class="trash-actions">' +
          (g.id === 'dups' && g.ids.length > 1 ? '<button data-merge-dups title="Behåll första, flytta resten till papperskorgen">Behåll 1</button>' : '') +
          '<button data-cleanup="' + g.id + '" title="Markera">' + icon('check') + '</button></div></div>';
    }).join('');
  }

  function mergeDuplicates() {
    var groups = {};
    state.files.forEach(function (f) {
      var k = duplicateKey(f);
      (groups[k] = groups[k] || []).push(f);
    });
    var remove = [];
    Object.keys(groups).forEach(function (k) {
      if (groups[k].length > 1) remove = remove.concat(groups[k].slice(1));
    });
    if (!remove.length) { toast('Inga dubletter att slå ihop'); return; }
    if (!confirm('Behåll en av varje dublett och flytta ' + remove.length + ' fil(er) till papperskorgen?')) return;
    remove.forEach(function (f) { Store.softDelete(f); });
    var gone = new Set(remove.map(function (f) { return f.id; }));
    state.files = state.files.filter(function (f) { return !gone.has(f.id); });
    renderFiles(); renderCleanup(); renderTrash();
    toast(remove.length + ' dubletter flyttade till papperskorgen 🗑️');
    Store.logActivity('delete', 'dublett-sammanslagning: ' + remove.length);
  }

  /* ---------------- Statistik + analytics ---------------- */
  function levelInfo(n) {
    var level = Math.floor(Math.sqrt(n * 2)) + 1;
    var prev = Math.pow(level - 1, 2) / 2;
    var next = Math.pow(level, 2) / 2;
    var pct = Math.max(4, Math.min(100, Math.round((n - prev) / Math.max(1, next - prev) * 100)));
    return { level: level, pct: pct, name: LEVELS[Math.min(level - 1, LEVELS.length - 1)], next: Math.ceil(next - n) };
  }

  function renderStats() {
    var files = state.files;
    var bytes = files.reduce(function (a, f) { return a + (Number(f.size) || 0); }, 0);
    var imgs = files.filter(function (f) { return category(f.type, f.name) === 'image'; }).length;
    var lv = levelInfo(files.length);
    var sets = $('#stats');
    if (sets) sets.innerHTML = [
      ['Filer', files.length, 'files'],
      ['Lagring', Store.fmtBytes(bytes), 'database'],
      ['Bilder', imgs, 'image'],
      ['Status', Store.getAdapter().isDemo ? 'Demo' : 'Live', 'activity']
    ].map(function (s) {
      return '<div class="stat"><div class="stat-ic">' + icon(s[2]) + '</div>' +
        '<div class="stat-body"><div class="stat-val">' + esc(s[1]) + '</div>' +
        '<div class="stat-label">' + esc(s[0]) + '</div></div></div>';
    }).join('');

    var counts = {};
    var sizes = {};
    files.forEach(function (f) {
      var c = category(f.type, f.name);
      counts[c] = (counts[c] || 0) + 1;
      sizes[c] = (sizes[c] || 0) + (Number(f.size) || 0);
    });
    var totalBytes = Object.keys(sizes).reduce(function (a, k) { return a + sizes[k]; }, 0) || 1;
    var colors = { image: '#9bff5a', video: '#a084ff', audio: '#ffb347', code: '#8affc1', doc: '#6fd3ff', archive: '#ff8f6b', other: '#7f9c87' };
    var bar = $('#storageBar');
    if (bar) bar.innerHTML = Object.keys(sizes).filter(function (k) { return sizes[k] > 0; }).sort(function (a, b) { return sizes[b] - sizes[a]; }).map(function (k) {
      return '<i style="width:' + (sizes[k] / totalBytes * 100).toFixed(2) + '%;background:' + colors[k] + '" title="' + CAT_LABEL[k] + ': ' + Store.fmtBytes(sizes[k]) + '"></i>';
    }).join('') || '<i style="width:100%;background:rgba(155,255,90,.12)"></i>';
    var legend = $('#storageLegend');
    if (legend) legend.innerHTML = Object.keys(counts).filter(function (k) { return counts[k] > 0; }).map(function (k) {
      return '<span><i style="background:' + colors[k] + '"></i>' + CAT_LABEL[k] + ' <b>' + counts[k] + '</b></span>';
    }).join('') || '<span class="muted">Inga filer ännu</span>';

    var xpFill = $('#xpFill');
    if (xpFill) xpFill.style.width = lv.pct + '%';
    var xpLabel = $('#xpLabel');
    if (xpLabel) xpLabel.textContent = 'Nivå ' + lv.level + ' · ' + lv.name + (lv.next > 0 ? ' · ' + lv.next + (lv.next === 1 ? ' fil till' : ' filer till') : ' · maxad');
  }

  /* ---------------- Filgrid ---------------- */
  function filteredFiles() {
    var q = parseQuery(state.query);
    var week = Date.now() - 7 * 86400000;
    var scored = state.files.filter(function (f) {
      var catOk = state.filter === 'all' || (state.filter === 'starred' ? !!f.starred : category(f.type, f.name) === state.filter);
      var coll = state.collection;
      var collOk = coll.type === 'all' ||
        (coll.type === 'starred' && !!f.starred) ||
        (coll.type === 'pinned' && !!f.pinned) ||
        (coll.type === 'recent' && new Date(f.createdAt).getTime() > week) ||
        (coll.type === 'folder' && String(f.folder || '') === coll.value) ||
        (coll.type === 'tag' && (f.tags || []).some(function (t) { return String(t) === coll.value; })) ||
        (coll.type === 'duplicates' && isDuplicate(f));
      return catOk && collOk && matchesQuery(f, q);
    }).map(function (f) { return { f: f, s: searchScore(f, q) }; });
    scored.sort(function (a, b) {
      if (q.text.length && a.s !== b.s) return b.s - a.s; // Sökrelevans först
      var A = a.f, B = b.f;
      var pinDiff = (B.pinned ? 1 : 0) - (A.pinned ? 1 : 0);
      if (pinDiff) return pinDiff;
      if (state.sort === 'oldest') return new Date(A.createdAt) - new Date(B.createdAt);
      if (state.sort === 'name') return String(A.name).localeCompare(String(B.name));
      if (state.sort === 'size') return (B.size || 0) - (A.size || 0);
      if (state.sort === 'starred') return (B.starred ? 1 : 0) - (A.starred ? 1 : 0) || new Date(B.createdAt) - new Date(A.createdAt);
      return new Date(B.createdAt) - new Date(A.createdAt);
    });
    return scored.map(function (o) { return o.f; });
  }

  function fileCard(f, i) {
    var cat = category(f.type, f.name);
    var isImg = cat === 'image';
    var thumb = isImg && f.url
      ? '<img src="' + esc(f.url) + '" alt="" loading="lazy" onerror="this.style.display=\'none\'">'
      : '<div class="big-ic">' + (f.icon ? '<span style="font-size:2.2rem">' + esc(f.icon) + '</span>' : icon(CAT_ICON[cat])) + '</div>';
    var date = '';
    try { date = new Date(f.createdAt).toLocaleDateString('sv-SE', { day: 'numeric', month: 'short', year: 'numeric' }); } catch (e) {}
    var sel = state.selected.has(f.id);
    var dup = isDuplicate(f);
    var left = Math.max(0, Math.ceil(60 - (Date.now() - new Date(f.createdAt).getTime()) / 60000));
    var expiring = !f.permanent && left <= 60;
    return '<article class="file-card reveal ' + (sel ? 'selected' : '') + (dup ? ' duplicate' : '') + '" draggable="true" data-id="' + esc(f.id) + '" style="animation-delay:' + Math.min(i * 22, 300) + 'ms">' +
      '<div class="thumb cat-' + cat + '">' + thumb +
        '<button class="pick" data-act="select" aria-label="Välj fil">' + icon(sel ? 'check' : 'plus') + '</button>' +
        '<span class="cat-badge">' + esc(CAT_LABEL[cat]) + '</span>' +
        (f.starred ? '<span class="star-badge">★</span>' : '') +
        (f.pinned ? '<span class="pin-badge">📌</span>' : '') +
        (dup ? '<span class="dup-badge">DUBBLETT</span>' : '') +
        (expiring ? '<span class="exp-badge">⏳ ' + left + 'm</span>' : '') +
      '</div>' +
      '<div class="file-info" data-act="preview">' +
        '<div class="file-name" title="' + esc(f.name) + '">' + esc(f.name) + '</div>' +
        '<div class="file-meta">' + esc(Store.fmtBytes(f.size)) + ' · ' + esc(date) + (f.folder ? ' · 📁 ' + esc(f.folder) : '') + '</div>' +
        (f.note ? '<div class="note-preview">📝 ' + esc(String(f.note).slice(0, 60)) + '</div>' : '') +
        ((f.tags || []).length ? '<div class="mini-tags">' + f.tags.slice(0, 3).map(function (t) { return '<span style="color:' + tagColor(t) + '">#' + esc(t) + '</span>'; }).join('') + '</div>' : '') +
      '</div>' +
      '<div class="file-actions">' +
        '<button class="act" data-act="preview" title="Förhandsvisa" aria-label="Förhandsvisa">' + icon('eye') + '</button>' +
        '<button class="act copy" data-act="copy" title="Kopiera länk" aria-label="Kopiera länk">' + icon('link') + '</button>' +
        '<button class="act open" data-act="open" title="Öppna fil" aria-label="Öppna fil">' + icon('external') + '</button>' +
        '<button class="act star" data-act="star" title="Stjärnmärk" aria-label="Stjärnmärk">' + icon(f.starred ? 'star-on' : 'star') + '</button>' +
        '<button class="act pin" data-act="pin" title="Fäst" aria-label="Fäst">' + icon('pin') + '</button>' +
        '<button class="act" data-act="renameInline" title="Byt namn" aria-label="Byt namn">' + icon('edit') + '</button>' +
        (Store.getAdapter().canDelete ? '<button class="act del" data-act="delete" title="Ta bort" aria-label="Ta bort">' + icon('trash') + '</button>' : '') +
      '</div>' +
    '</article>';
  }

  function renderFiles() {
    var grid = $('#fileGrid');
    if (!grid) return;
    var list = filteredFiles();
    grid.classList.toggle('list', state.view === 'list');
    $('#viewGrid') && $('#viewGrid').classList.toggle('active', state.view === 'grid');
    $('#viewList') && $('#viewList').classList.toggle('active', state.view === 'list');
    if (!list.length) {
      grid.innerHTML = '';
      var empty = $('#emptyState'); if (empty) empty.hidden = false;
      var title = $('#emptyTitle'), text = $('#emptyText');
      if (state.files.length) {
        if (title) title.textContent = 'Inga träffar i terrariet';
        if (text) text.textContent = 'Prova ett annat sökord eller välj en annan kategori.';
      } else {
        if (title) title.textContent = 'Terrariet är tomt';
        if (text) text.textContent = 'Släng in din första fil ovan – bild, kod, ljud, vad som helst.';
      }
    } else {
      var empty2 = $('#emptyState'); if (empty2) empty2.hidden = true;
      grid.innerHTML = list.map(fileCard).join('');
      observeReveals(grid);
    }
    renderStats();
    renderSelectionBar();
    var count = $('#resultCount');
    if (count) count.textContent = list.length + (list.length === 1 ? ' fil' : ' filer');
    $$('#filterBar .chip').forEach(function (c) { c.classList.toggle('active', c.dataset.filter === state.filter); });
    renderCollections();
    renderTagColors();
    if (state.ready) checkAchievements();
  }

  function renderProjects() {
    var wrap = $('#projectGrid');
    if (!wrap) return;
    var projects = settings.projects || [];
    var isLocal = /^(file:|http:\/\/(localhost|127\.0\.0\.1))/i.test(location.href);
    wrap.innerHTML = projects.map(function (p, i) {
      var href = isLocal ? (p.href || '#') : (p.githubHref || p.href || '#');
      var gh = p.githubHref || 'https://github.com/thashamans-hub-hub?tab=repositories';
      return '<article class="project-card reveal" style="--pc:' + esc(p.accent || '#9bff5a') + ';animation-delay:' + (i * 70) + 'ms">' +
        '<a class="project-main" href="' + esc(href) + '"' +
          (String(href).indexOf('http') === 0 ? ' target="_blank" rel="noopener"' : '') + '>' +
          '<div class="project-top"><span class="project-ic">' + esc(p.icon || '🌿') + '</span>' + icon('external') + '</div>' +
          '<h3>' + esc(p.name) + '</h3><p>' + esc(p.desc || '') + '</p>' +
          '<div class="tags">' + (p.tags || []).map(function (t) { return '<span>' + esc(t) + '</span>'; }).join('') + '</div>' +
        '</a>' +
        '<a class="project-gh" href="' + esc(gh) + '" target="_blank" rel="noopener">GitHub ↗</a>' +
      '</article>';
    }).join('');
    observeReveals(wrap);
  }

  function loadGitHubInfo() {
    var profile = $('#ghProfile'), repo = $('#ghRepo');
    if (!profile || !repo) return;
    var repoUrl = 'https://github.com/thashamans-hub-hub/gaggo-projects';
    var fallback = function () {
      profile.innerHTML = '<div class="gh-head"><h3>GaGGo på GitHub</h3></div>' +
        '<p class="gh-bio">Profilstatistiken kunde inte hämtas just nu – länkarna fungerar ändå.</p>' +
        '<div class="gh-links"><a href="https://github.com/thashamans-hub" target="_blank" rel="noopener">Profil ↗</a><a href="' + repoUrl + '" target="_blank" rel="noopener">Repo ↗</a></div>';
      repo.innerHTML = '<div class="gh-head"><h3>gaggo-projects</h3></div>' +
        '<p class="gh-bio">Repo-statistiken är inte tillgänglig offline.</p>' +
        '<div class="gh-links"><a href="' + repoUrl + '" target="_blank" rel="noopener">Öppna repo ↗</a><a href="' + repoUrl + '/archive/refs/heads/main.zip" target="_blank" rel="noopener">Ladda ner ZIP ↗</a></div>';
    };
    var get = function (url) {
      return fetch(url).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      });
    };
    Promise.all([
      get('https://api.github.com/users/thashamans-hub'),
      get('https://api.github.com/repos/thashamans-hub/gaggo-projects')
    ]).then(function (res) {
      var u = res[0], r = res[1];
      profile.innerHTML = '<div class="gh-head"><img class="gh-avatar" src="' + esc(u.avatar_url) + '" alt="">' +
        '<div><h3>' + esc(u.login) + '</h3><span>Offentlig GitHub-profil</span></div></div>' +
        (u.bio ? '<p class="gh-bio">' + esc(u.bio) + '</p>' : '') +
        '<div class="gh-stats"><span><b>' + (u.public_repos || 0) + '</b>repos</span><span><b>' + (u.followers || 0) + '</b>följare</span><span><b>' + (u.following || 0) + '</b>följer</span></div>' +
        '<div class="gh-links"><a href="' + esc(u.html_url) + '" target="_blank" rel="noopener">Profil ↗</a><a href="https://github.com/thashamans-hub?tab=repositories" target="_blank" rel="noopener">Alla repo ↗</a></div>';
      repo.innerHTML = '<div class="gh-head"><h3>' + esc(r.name) + '</h3><span>publikt repo · main</span></div>' +
        '<p class="gh-bio">' + esc(r.description || 'GaGGos Projects – den gröna filvaulten.') + '</p>' +
        '<div class="gh-stats"><span><b>' + (r.stargazers_count || 0) + '</b>stars</span><span><b>' + (r.forks_count || 0) + '</b>forks</span><span><b>' + (r.open_issues_count || 0) + '</b>issues</span></div>' +
        '<div class="gh-links"><a href="' + esc(r.html_url) + '" target="_blank" rel="noopener">Repo ↗</a><a href="' + esc(r.html_url) + '/archive/refs/heads/main.zip" target="_blank" rel="noopener">ZIP ↗</a><a href="https://thashamans-hub.github.io/gaggo-projects/" target="_blank" rel="noopener">Demo ↗</a></div>';
      observeReveals($('#community'));
    }).catch(fallback);
  }

  /* ---------------- Scroll reveal ---------------- */
  var revealObserver = null;
  function observeReveals(root) {
    if (!('IntersectionObserver' in window) || theme.motion === false) return;
    if (!revealObserver) {
      revealObserver = new IntersectionObserver(function (entries) {
        entries.forEach(function (e) {
          if (e.isIntersecting) { e.target.classList.add('seen'); revealObserver.unobserve(e.target); }
        });
      }, { threshold: 0.08, rootMargin: '0px 0px -30px' });
    }
    $$('.reveal:not(.seen)', root || document).forEach(function (el) { revealObserver.observe(el); });
  }

  /* ---------------- Uppladdning ---------------- */
  function setQueueItem(id, pct, status, extra) {
    var old = state.queue[id] || {};
    state.queue[id] = Object.assign({ pct: pct, status: status }, old, extra || {});
    if (status) state.queue[id].status = status;
    renderQueue();
  }

  function renderQueue() {
    var wrap = $('#uploadQueue');
    if (!wrap) return;
    var ids = Object.keys(state.queue);
    wrap.innerHTML = ids.map(function (id) {
      var q = state.queue[id];
      var done = q.status === 'done', err = q.status === 'error', canceled = q.status === 'canceled';
      var label = err ? 'Fel' : canceled ? 'Avbruten' : done ? '100%' : (q.status === 'paused' ? 'Offline' : q.pct + '%');
      return '<div class="queue-row ' + (done ? 'done' : '') + ' ' + (err ? 'err' : '') + ' ' + (canceled ? 'canceled' : '') + '">' +
        '<span class="queue-name">' + icon(done ? 'check' : err ? 'alert' : canceled ? 'close' : 'loader') +
          '<span>' + esc(q.name || 'Fil') + (q.folder ? ' · ' + esc(q.folder) : '') + '</span></span>' +
        '<span class="queue-pct">' + label + '</span>' +
        '<div class="queue-bar"><i style="width:' + (err || canceled ? 100 : q.pct) + '%"></i></div>' +
        '<div class="queue-tools">' +
          (!done && !err && !canceled ? '<button data-cancel="' + esc(id) + '" title="Avbryt">Avbryt</button>' : '') +
          (err ? '<button data-retry="' + esc(id) + '" title="Försök igen">Försök igen</button>' : '') +
          (done ? '<button data-queue-open="' + esc(id) + '" title="Öppna">Öppna</button>' : '') +
          '<button data-queue-dismiss="' + esc(id) + '" title="Stäng">×</button>' +
        '</div>' +
      '</div>';
    }).join('');
  }

  function scheduleQueueCleanup() {
    var token = state.queueToken;
    clearTimeout(state.queueTimer);
    state.queueTimer = setTimeout(function () {
      if (state.queueToken !== token) return;
      var done = Object.keys(state.queue).filter(function (k) { return ['done', 'canceled'].indexOf(state.queue[k].status) >= 0; });
      done.forEach(function (k) { delete state.queue[k]; });
      renderQueue();
    }, 2200);
  }

  function uploadFiles(fileList, folder) {
    var files = Array.prototype.slice.call(fileList || []);
    if (!files.length) return;
    if (files.length > 25) {
      toast('Max 25 filer åt gången – resten ignorerades.', 'err');
      files = files.slice(0, 25);
    }
    if (navigator.onLine === false) {
      // Kö offline: startas automatiskt när vi är online igen.
      state.queueToken++;
      var queued = files.map(function (f) {
        var qid = uidLocal();
        var sub = folder || (f.webkitRelativePath ? String(f.webkitRelativePath).split('/')[0] : '');
        state.queue[qid] = { qid: qid, pct: 0, status: 'paused', name: f.name, folder: sub, pending: f };
        return f;
      });
      renderQueue();
      toast('Du är offline – ' + queued.length + ' uppladdning(ar) köade och startar när anslutningen kommer tillbaka.', 'err');
      window.addEventListener('online', function once() {
        window.removeEventListener('online', once);
        var pending = [];
        Object.keys(state.queue).forEach(function (k) {
          var q = state.queue[k];
          if (q.status === 'paused' && q.pending) { pending.push(q.pending); delete state.queue[k]; }
        });
        renderQueue();
        if (pending.length) uploadFiles(pending);
      });
      return;
    }
    state.queueToken++;
    var jobs = files.map(function (f) {
      var qid = uidLocal();
      var sub = folder || (f.webkitRelativePath ? String(f.webkitRelativePath).split('/')[0] : '');
      var job = { file: f, qid: qid, folder: sub };
      return job;
    });
    jobs.forEach(function (j) { state.queue[j.qid] = { pct: 0, status: 'upload', name: j.file.name, folder: j.folder }; });
    renderQueue();
    var running = 0, index = 0, concurrency = Math.min(3, jobs.length);
    function pump() {
      while (running < concurrency && index < jobs.length) {
        var job = jobs[index++]; running++;
        if (!Store.getAdapter().isDemo) { /* riktig upload */ }
        (function (j) {
          var adapter = Store.getAdapter();
          j.controller = new AbortController();
          state.cancelled.delete(j.qid);
          setQueueItem(j.qid, 0, 'upload', { controller: j.controller });
          adapter.upload(j.file, function (pct) {
            if (!state.cancelled.has(j.qid)) setQueueItem(j.qid, pct, 'upload');
          }, j.controller.signal).then(function (meta) {
            if (state.cancelled.has(j.qid)) return;
            if (j.folder) { meta.folder = j.folder; Store.updateMeta(meta); }
            state.files.unshift(meta);
            if ((Number(j.file.size) || 0) <= 20 * 1048576) {
              Store.putFileBlob(meta.id, j.file).catch(function () {});
            }
            delete state.failed[j.qid];
            setQueueItem(j.qid, 100, 'done', { meta: meta });
            renderFiles();
            toast(meta.name + ' är uppe 🌿');
            Store.logActivity('upload', meta.name);
            var acts = Store.getActivity();
            var lastBackup = acts.find(function (a) { return a.action === 'backup'; });
            var since = acts.filter(function (a) {
              return a.action === 'upload' && (!lastBackup || new Date(a.at) > new Date(lastBackup.at));
            }).length;
            if (since > 0 && since % 25 === 0) toast('25 uppladdningar sedan senaste backup – gör en i Inställningar 💾', 'err');
          }).catch(function (e) {
            if (e && e.name === 'AbortError') setQueueItem(j.qid, 0, 'canceled');
            else {
              state.failed[j.qid] = j;
              setQueueItem(j.qid, 0, 'error', { error: e.message });
              toast('Kunde inte ladda upp ' + j.file.name + ': ' + e.message, 'err');
            }
          }).then(function () { running--; scheduleQueueCleanup(); pump(); });
        })(job);
      }
    }
    pump();
  }

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
    return new Promise(function (resolve, reject) {
      var ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); resolve(); } catch (e) { reject(e); }
      ta.remove();
    });
  }

  function findFile(id) { return state.files.find(function (f) { return f.id === id; }); }

  function downloadFiles(files) {
    files.forEach(function (f, i) {
      Store.getAdapter().getUrl(f).then(function (url) {
        if (!url) return;
        var a = document.createElement('a');
        a.href = url; a.download = f.name || 'fil';
        document.body.appendChild(a); a.click(); a.remove();
      });
    });
  }

  function openQr(id) {
    var f = findFile(id);
    if (!f) return;
    Store.getAdapter().getUrl(f).then(function (url) {
      if (!url) { toast('Filen har ingen länk', 'err'); return; }
      state.qrUrl = url;
      var label = $('#qrUrl'); if (label) label.textContent = url;
      var img = $('#qrImage'), fallback = $('#qrFallback');
      if (img) {
        img.onerror = function () { img.style.display = 'none'; if (fallback) fallback.hidden = false; };
        img.onload = function () { img.style.display = ''; if (fallback) fallback.hidden = true; };
        img.src = 'https://api.qrserver.com/v1/create-qr-code/?size=240x240&margin=8&data=' + encodeURIComponent(url);
      }
      openModal('qrModal');
    }).catch(function () { toast('Kunde inte hämta länken', 'err'); });
  }

  function createSharePage(files) {
    if (!files.length) { toast('Inga filer att dela', 'err'); return; }
    Promise.all(files.map(function (f) {
      return Store.getAdapter().getUrl(f).then(function (url) { return { f: f, url: url }; });
    })).then(function (items) {
      var cards = items.map(function (it) {
        var f = it.f, url = it.url;
        var thumb = category(f.type, f.name) === 'image' && url
          ? '<img src="' + esc(url) + '" alt="">'
          : '<div class="thumb-ic">' + (f.icon || '📄') + '</div>';
        return '<article>' + thumb + '<h3>' + esc(f.name) + '</h3>' +
          '<p>' + esc(Store.fmtBytes(f.size)) + '</p>' +
          '<a href="' + esc(url) + '" target="_blank" rel="noopener">Öppna fil →</a></article>';
      }).join('');
      var html = '<!doctype html><html lang="sv"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
        '<title>' + esc(brand.name || 'GaGGos Projects') + ' · Delning</title><style>' +
        'body{margin:0;padding:48px 24px;background:#070d0a;color:#f0faf1;font-family:system-ui,sans-serif}' +
        'h1{font-size:2.4rem;margin:0 0 6px}p{color:#93a99a}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:16px;margin-top:32px}' +
        'article{background:#102019;border:1px solid #20452c;border-radius:16px;overflow:hidden}article img{width:100%;height:140px;object-fit:cover}' +
        '.thumb-ic{height:140px;display:grid;place-items:center;font-size:2.4rem;background:#13291b}h3{font-size:.95rem;margin:12px 14px 4px}article p{margin:0 14px 12px;font-size:.75rem}' +
        'a{display:block;margin:0 14px 14px;padding:9px;background:#9bff5a;color:#07150c;border-radius:9px;text-decoration:none;font-weight:700;text-align:center}' +
        '</style></head><body><h1>🌿 ' + esc(brand.name || 'GaGGos Projects') + '</h1><p>Delad samling · ' + items.length + ' filer</p>' +
        '<div class="grid">' + cards + '</div></body></html>';
      var blob = new Blob([html], { type: 'text/html;charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url; a.download = 'gaggo-share.html';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
      toast('Delningssida skapad 🌐');
      Store.logActivity('sharepage', items.length + ' filer');
    }).catch(function (e) { toast('Kunde inte skapa delningssida: ' + e.message, 'err'); });
  }

  function createBackup() {
    if (!window.TerrariumZip) { toast('ZIP-stödet kunde inte laddas', 'err'); return; }
    toast('Skapar full säkerhetskopia…');
    var enc = new TextEncoder();
    function backupName(f, i) {
      return 'files/' + String(i + 1).padStart(3, '0') + '-' + String(f.name || 'fil').replace(/[^a-zA-Z0-9._-]/g, '_');
    }
    var fileMap = {};
    state.files.forEach(function (f, i) { fileMap[f.id] = backupName(f, i); });
    var entries = [
      { name: 'manifest.json', data: enc.encode(JSON.stringify({
        app: 'GaGGos Projects', version: 7, exportedAt: new Date().toISOString(),
        fileCount: state.files.length, fileMap: fileMap
      }, null, 2)) },
      { name: 'metadata.json', data: enc.encode(Store.exportMetadata()) },
      { name: 'metadata.csv', data: enc.encode(Store.exportCSV()) },
      { name: 'activity.json', data: enc.encode(JSON.stringify(Store.getActivity(), null, 2)) },
      { name: 'achievements.json', data: enc.encode(JSON.stringify(Store.getAchievements(), null, 2)) },
      { name: 'settings.json', data: enc.encode(JSON.stringify(Store.settings, null, 2)) }
    ];
    Promise.all(state.files.map(function (f, i) {
      return Store.getAdapter().getUrl(f).then(function (url) {
        return fileBytes(f, url);
      }).then(function (buf) {
        return { name: backupName(f, i), data: new Uint8Array(buf) };
      }).catch(function () { return null; });
    })).then(function (fileEntries) {
      var valid = fileEntries.filter(Boolean);
      var blob = window.TerrariumZip.createZip(entries.concat(valid));
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url; a.download = 'gaggo-backup-' + new Date().toISOString().slice(0, 10) + '.zip';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
      toast('Backup klar – ' + valid.length + ' filer 📦');
      Store.logActivity('backup', valid.length + ' filer');
    }).catch(function (e) { toast('Backup misslyckades: ' + e.message, 'err'); });
  }

  function restoreBackup(file) {
    if (!window.TerrariumZipReader) { toast('ZIP-läsaren kunde inte laddas', 'err'); return; }
    toast('Läser backup…');
    file.arrayBuffer().then(function (buf) {
      var entries = window.TerrariumZipReader.read(buf);
      var manifestText = window.TerrariumZipReader.text(entries, 'manifest.json');
      var metaText = window.TerrariumZipReader.text(entries, 'metadata.json');
      if (!metaText) throw new Error('metadata.json saknas i backupen');
      var manifest = manifestText ? JSON.parse(manifestText) : {};
      var n = Store.importMetadata(metaText);
      var settingsText = window.TerrariumZipReader.text(entries, 'settings.json');
      if (settingsText) Store.saveSettings(JSON.parse(settingsText));
      var activityText = window.TerrariumZipReader.text(entries, 'activity.json');
      if (activityText) localStorage.setItem('terrarium.activity.v1', activityText);
      var achievementsText = window.TerrariumZipReader.text(entries, 'achievements.json');
      if (achievementsText) localStorage.setItem('terrarium.achievements.v1', achievementsText);
      var map = manifest.fileMap || {};
      return Promise.all(Object.keys(map).map(function (id) {
        var data = entries[map[id]];
        if (!data) return null;
        return Store.putFileBlob(id, new Blob([data]));
      })).then(function () {
        settings = Store.settings; brand = settings.brand; theme = settings.theme;
        state.view = theme.view;
        applyBrand(); applyTheme(); applyWallpaper(); fillSettingsForm();
        boot(true);
        toast('Backup återställd – ' + n + ' filer 🌿');
        Store.logActivity('restore-backup', n + ' filer');
      });
    }).catch(function (e) { toast('Kunde inte läsa backup: ' + e.message, 'err'); });
  }

  function uploadFromUrl() {
    var url = prompt('Limma in en URL till filen:');
    if (!url || !/^https?:\/\//i.test(url.trim())) { if (url) toast('Ogiltig URL', 'err'); return; }
    toast('Hämtar filen…');
    fetch(url.trim()).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.blob().then(function (blob) {
        var path = new URL(url.trim()).pathname;
        var name = decodeURIComponent(path.split('/').pop() || 'nedladdning');
        if (!name.includes('.')) name += '.bin';
        return new File([blob], name, { type: blob.type || 'application/octet-stream' });
      });
    }).then(function (file) {
      uploadFiles([file]);
      toast('URL-fil hämtad 🌿');
    }).catch(function (e) {
      toast('Kunde inte hämta URL: ' + e.message + ' (CORS kan blockera)', 'err');
    });
  }

  function exportZip(files) {
    if (!window.TerrariumZip) { toast('ZIP-stödet kunde inte laddas', 'err'); return; }
    if (!files.length) { toast('Inga filer att packa', 'err'); return; }
    toast('Packar ' + files.length + ' filer…');
    Promise.all(files.map(function (f) {
      return Store.getAdapter().getUrl(f).then(function (url) {
        if (!url) throw new Error('Ingen URL');
        return fileBytes(f, url);
      }).then(function (buf) {
        return { name: f.name || 'fil', data: new Uint8Array(buf) };
      }).catch(function () { return null; });
    })).then(function (entries) {
      var valid = entries.filter(Boolean);
      if (!valid.length) throw new Error('Inga filer kunde hämtas');
      var blob = window.TerrariumZip.createZip(valid);
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url; a.download = 'gaggo-projects-' + new Date().toISOString().slice(0, 10) + '.zip';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
      toast('ZIP klar – ' + valid.length + ' filer 📦');
      Store.logActivity('zip', valid.length + ' filer');
    }).catch(function (e) { toast('Kunde inte skapa ZIP: ' + e.message, 'err'); });
  }

  function removeFiles(files) {
    var names = files.map(function (f) { return f.name; }).join(', ');
    if (!confirm('Flytta ' + files.length + ' fil(er) till papperskorgen?\n' + names)) return;
    var gone = new Set(files.map(function (f) { return f.id; }));
    files.forEach(function (f) { Store.softDelete(f); });
    state.files = state.files.filter(function (f) { return !gone.has(f.id); });
    gone.forEach(function (id) { state.selected.delete(id); });
    if (state.previewId && gone.has(state.previewId)) closeModal('previewModal');
    renderFiles();
    toast(files.length + ' fil(er) flyttade till papperskorgen 🗑️');
    Store.logActivity('delete', names);
  }

  function fileBytes(f, url) {
    return Store.getFileBlob(f.id).then(function (blob) {
      if (blob) return blob.arrayBuffer();
      return fetch(url, { cache: 'no-store' }).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.arrayBuffer();
      });
    });
  }

  function renewFile(f, quiet) {
    if (!f || !f.id) return Promise.resolve(false);
    return Store.getFileBlob(f.id).then(function (blob) {
      if (!blob) return false;
      var file = new File([blob], f.name || 'fil', { type: f.type || blob.type || 'application/octet-stream' });
      var oldId = f.id;
      return Store.getAdapter().upload(file, null).then(function (fresh) {
        Store.dropMeta(oldId);
        f.url = fresh.url;
        f.path = fresh.path;
        f.createdAt = fresh.createdAt;
        f.id = fresh.id;
        return Store.updateMeta(f).then(function () { return true; });
      });
    }).catch(function () { return false; }).then(function (ok) {
      if (ok && !quiet) { renderFiles(); toast(f.name + ' fick ny länk 🔄'); Store.logActivity('renew', f.name); }
      return ok;
    });
  }

  function renewSelected() {
    var files = selectedFiles();
    if (!files.length) { toast('Markera filer att förnya först', 'err'); return; }
    toast('Förnyar ' + files.length + ' länkar…');
    Promise.all(files.map(function (f) { return renewFile(f, true); })).then(function (results) {
      var n = results.filter(Boolean).length;
      renderFiles();
      toast(n + ' länkar förnyade 🔄');
      Store.logActivity('renew', n + ' länkar');
    });
  }

  function startAutoRenew() {
    setInterval(function () {
      if (!theme.autoRenew || !state.ready || navigator.onLine === false) return;
      if (Store.getAdapter().id !== 'tmpfiles') return;
      var stale = state.files.filter(function (f) {
        return Date.now() - new Date(f.createdAt).getTime() > 50 * 60000;
      });
      if (!stale.length) return;
      Promise.all(stale.slice(0, 5).map(function (f) { return renewFile(f, true); })).then(function (res) {
        if (res.some(Boolean)) { renderFiles(); toast('Länkar förnyade automatiskt 🔄'); }
      });
    }, 5 * 60000);
  }

  function restoreTrash(id) {
    var meta = Store.restoreFromTrash(id);
    if (!meta) return;
    state.files.unshift(meta);
    renderFiles(); renderTrash();
    toast(meta.name + ' är tillbaka 🌿');
    Store.logActivity('restore', meta.name);
  }

  function purgeTrash(id) {
    var item = Store.getTrash().find(function (t) { return t.id === id; });
    if (!item) return;
    if (!confirm('Rensa ' + item.meta.name + ' permanent? Det går inte att ångra.')) return;
    Store.getAdapter().remove(item.meta).then(function () {
      Store.dropFromTrash(id);
      renderTrash();
      toast('Rensat permanent');
      Store.logActivity('purge', item.meta.name);
    }).catch(function (e) { toast('Kunde inte rensa: ' + e.message, 'err'); });
  }

  function renderTrash() {
    var wrap = $('#trashList');
    if (!wrap) return;
    var list = Store.getTrash();
    var dot = $('#trashDot');
    if (dot) dot.hidden = list.length === 0;
    if (!list.length) {
      wrap.innerHTML = '<div class="empty"><div class="empty-ic">🗑️</div><h3>Papperskorgen är tom</h3><p>Snyggt – inget att städa här.</p></div>';
      return;
    }
    wrap.innerHTML = list.map(function (t) {
      var when = relTime(t.deletedAt);
      return '<div class="tl-row trash-row"><div class="tl-ic">' + icon('trash') + '</div>' +
        '<div><div class="tl-text">' + esc(t.meta.name) + '</div><div class="tl-detail">' + esc(Store.fmtBytes(t.meta.size)) + ' · ' + esc(when) + '</div></div>' +
        '<div class="trash-actions">' +
          '<button data-restore="' + esc(t.id) + '" title="Återställ">' + icon('undo') + '</button>' +
          '<button class="purge" data-purge="' + esc(t.id) + '" title="Rensa permanent">' + icon('close') + '</button>' +
        '</div></div>';
    }).join('');
  }

  /* ---------------- Markering ---------------- */
  function renderSelectionBar() {
    var bar = $('#selectionBar');
    if (!bar) return;
    var n = state.selected.size;
    bar.hidden = n === 0;
    if (!n) return;
    $('#selectedCount').textContent = n + (n === 1 ? ' fil vald' : ' filer valda');
  }
  function toggleSelect(id, force) {
    var on = typeof force === 'boolean' ? force : !state.selected.has(id);
    if (on) state.selected.add(id); else state.selected.delete(id);
    renderFiles();
  }
  function clearSelection() { state.selected.clear(); renderFiles(); }
  function selectAll() {
    filteredFiles().forEach(function (f) { state.selected.add(f.id); });
    renderFiles();
    renderSelectionBar();
  }
  function selectedFiles() { return state.files.filter(function (f) { return state.selected.has(f.id); }); }

  /* ---------------- Förhandsvisning ---------------- */
  function openPreview(id) {
    var f = findFile(id);
    if (!f) return;
    state.previewId = id;
    openModal('previewModal');
    renderPreview();
  }

  function slideshowNext() {
    var imgs = filteredFiles().filter(function (f) { return category(f.type, f.name) === 'image'; });
    if (!imgs.length) return;
    var i = imgs.findIndex(function (f) { return f.id === state.previewId; });
    openPreview(imgs[(i + 1 + imgs.length) % imgs.length].id);
  }

  function toggleSlideshow() {
    if (state.slideTimer) {
      clearInterval(state.slideTimer); state.slideTimer = null;
      toast('Slideshow pausad');
      return;
    }
    var imgs = filteredFiles().filter(function (f) { return category(f.type, f.name) === 'image'; });
    if (!imgs.length) { toast('Inga bilder i den här vyn', 'err'); return; }
    openPreview(imgs[0].id);
    state.slideTimer = setInterval(slideshowNext, 2600);
    var box = document.querySelector('#previewModal .modal-box');
    if (box && box.requestFullscreen) box.requestFullscreen().catch(function () {});
    toast('Slideshow igång ▶️');
    Store.logActivity('slideshow', imgs.length + ' bilder');
  }

  function previewNav(dir) {
    var list = filteredFiles();
    var i = list.findIndex(function (f) { return f.id === state.previewId; });
    var next = list[i + dir];
    if (next) { state.previewId = next.id; renderPreview(); }
  }

  // Sökfiltrering av textinnehållet i förhandsvisningen (kod/dokument).
  function addPreviewSearch(body) {
    if (!body) return;
    var input = $('#previewSearchInput');
    var pre = body.querySelector('pre.preview-code');
    if (!input || !pre || pre.__searchBound) return;
    pre.__searchBound = true;
    var orig = pre.innerHTML;
    input.addEventListener('input', function () {
      var q = String(input.value || '').toLowerCase();
      if (!q) { pre.innerHTML = orig; return; }
      pre.innerHTML = orig.split('\n').filter(function (l) {
        return String(l).toLowerCase().indexOf(q) >= 0;
      }).join('\n');
    });
  }

  function renderPreview() {
    var f = findFile(state.previewId);
    if (!f) return;
    var cat = category(f.type, f.name);
    var title = $('#previewTitle');
    if (title) title.textContent = f.name;
    var sub = $('#previewSub');
    if (sub) sub.textContent = CAT_LABEL[cat] + ' · ' + Store.fmtBytes(f.size) + (f.folder ? ' · 📁 ' + f.folder : '');
    var body = $('#previewBody');
    if (body) body.innerHTML = '<div class="preview-loading">' + icon('loader') + ' Laddar förhandsvisning…</div>';
    var nameInput = $('#editName'); if (nameInput) nameInput.value = f.name || '';
    var tagsInput = $('#editTags'); if (tagsInput) tagsInput.value = (f.tags || []).join(', ');
    var noteInput = $('#editNote'); if (noteInput) noteInput.value = f.note || '';
    renderVersionHistory(f);
    var tools = $('#imageTools'); if (tools) tools.hidden = cat !== 'image';
    state.transform = { rot: 0, x: 1, y: 1 };
    var starBtn = $('#previewStar'); if (starBtn) starBtn.innerHTML = icon(f.starred ? 'star-on' : 'star') + '<span>' + (f.starred ? 'Stjärnmärkt' : 'Stjärnmärk') + '</span>';

    Store.getAdapter().getUrl(f).then(function (url) {
      if (!url || state.previewId !== f.id) return;
      var html = '';
      if (cat === 'image') {
        html = '<div class="preview-stage zoomable" id="zoomStage"><img src="' + esc(url) + '" alt="' + esc(f.name) + '"></div>' +
          '<div class="zoom-hint">Klicka på bilden för att zooma · flytta musen för att fokusera</div>';
      } else if (cat === 'video') {
        html = '<div class="preview-stage"><video controls preload="metadata" src="' + esc(url) + '"></video></div>';
      } else if (cat === 'audio') {
        html = '<div class="preview-audio"><div class="audio-orbit">' + icon('music') + '</div><audio controls src="' + esc(url) + '"></audio></div>';
      } else if (cat === 'code' || cat === 'doc') {
        if (/\.pdf$/i.test(f.name || '')) {
          html = '<div class="pdf-stage"><iframe src="' + esc(url) + '#toolbar=1" title="' + esc(f.name) + '"></iframe></div>' +
            '<div class="zoom-hint">PDF visas i förhandsvisningen · öppna i ny flik för fullskärm</div>';
        } else html = '<div class="preview-loading">' + icon('loader') + ' Hämtar innehåll…</div>';
        if (!/\.pdf$/i.test(f.name || '')) {
          function showText(txt) {
            if (state.previewId !== f.id || !body) return;
            if (cat === 'code' && /\.md$/i.test(f.name || '')) {
              body.innerHTML = '<div class="preview-md">' + renderMarkdown(txt.slice(0, 60000)) + '</div>';
            } else {
              body.innerHTML = '<div class="preview-search"><input type="text" id="previewSearchInput" placeholder="Sök i innehållet…"></div><pre class="preview-code" id="previewCode">' + esc(txt.slice(0, 60000)) + '</pre>';
              addPreviewSearch(body);
            }
          }
          function showFallback() {
            if (state.previewId !== f.id || !body) return;
            body.innerHTML = '<div class="preview-fallback">' + icon(cat === 'code' ? 'code' : 'file') +
              '<h3>Kan inte visas här</h3><p>Filen kan vara privat eller blockera cross-origin. Öppna den i en ny flik.</p>' +
              '<a class="btn btn-primary" href="' + esc(url) + '" target="_blank" rel="noopener">' + icon('external') + ' Öppna fil</a></div>';
          }
          Store.getFileBlob(f.id).then(function (blob) {
            if (blob) return blob.text();
            return fetch(url).then(function (r) { return r.text(); });
          }).then(showText).catch(showFallback);
        }
        return;
      } else {
        html = '<div class="preview-fallback">' + icon('archive') + '<h3>Ingen förhandsvisning</h3>' +
          '<p>Den här filtypen visas inte direkt. Ladda ner eller öppna den istället.</p>' +
          '<a class="btn btn-primary" href="' + esc(url) + '" target="_blank" rel="noopener" download="' + esc(f.name) + '">' + icon('download') + ' Ladda ner</a></div>';
      }
      if (body && state.previewId === f.id) {
        body.innerHTML = html;
        if (cat === 'image') {
          var imgEl = body.querySelector('img');
          if (imgEl) imgEl.addEventListener('load', function () {
            if (state.previewId !== f.id) return;
            var subEl = $('#previewSub');
            if (subEl) subEl.textContent += ' · ' + imgEl.naturalWidth + '×' + imgEl.naturalHeight;
          });
        }
      }
    }).catch(function () {
      if (body && state.previewId === f.id) body.innerHTML = '<div class="preview-fallback">' + icon('alert') + '<h3>Kunde inte hämta filen</h3></div>';
    });
  }

  function saveEdit() {
    var f = findFile(state.previewId);
    if (!f) return;
    var n = $('#editName'), t = $('#editTags'), note = $('#editNote');
    f.name = (n && n.value.trim()) || f.name;
    f.tags = t ? t.value.split(',').map(function (x) { return x.trim().replace(/^#/, ''); }).filter(Boolean) : [];
    f.note = note ? note.value.trim() : (f.note || '');
    Store.updateMeta(f).then(function () {
      renderFiles(); renderPreview(); renderStats(); toast('Uppgifterna sparade ✏️');
      Store.logActivity('rename', f.name);
    });
  }

  function renderVersionHistory(f) {
    var wrap = $('#versionHistory');
    var list = $('#versionList');
    if (!wrap || !list) return;
    var versions = (f.versions || []).slice().reverse();
    wrap.hidden = !versions.length;
    if (!versions.length) { list.innerHTML = ''; return; }
    list.innerHTML = versions.map(function (v, i) {
      var when = relTime(v.at);
      var names = { name: 'namn', tags: 'taggar', note: 'anteckning', starred: 'stjärna', pinned: 'fäst', folder: 'mapp', icon: 'ikon' };
      var desc = (v.changes || []).map(function (k) { return names[k] || k; }).join(', ');
      return '<div class="version-row"><span>' + esc(when) + '</span><span>' + esc(desc) + '</span>' +
        '<button data-restore-version="' + (versions.length - 1 - i) + '">Återställ</button></div>';
    }).join('');
  }

  function restoreVersion(index) {
    var f = findFile(state.previewId);
    if (!f || !f.versions || !f.versions[index]) return;
    var v = f.versions[index];
    Object.keys(v.value || {}).forEach(function (k) { f[k] = v.value[k]; });
    f.versions = f.versions.slice(0, index);
    Store.updateMeta(f).then(function () { renderFiles(); renderPreview(); });
    toast('Version återställd ⏱️');
    Store.logActivity('rename', 'version återställd: ' + f.name);
  }

  /* ---------------- Åtgärder på filkort ---------------- */
  function onFileAction(e) {
    var btn = e.target.closest('[data-act]');
    if (!btn) return;
    var card = btn.closest('.file-card');
    if (!card) return;
    var f = findFile(card.dataset.id);
    if (!f) return;
    var act = btn.dataset.act;

    if (act === 'select') {
      e.stopPropagation();
      var list = filteredFiles();
      var idx = list.findIndex(function (x) { return x.id === f.id; });
      if (e.shiftKey && state.lastSelectIndex !== null && idx >= 0) {
        var lo = Math.min(state.lastSelectIndex, idx), hi = Math.max(state.lastSelectIndex, idx);
        for (var i = lo; i <= hi; i++) state.selected.add(list[i].id);
        state.lastSelectIndex = idx;
        renderFiles();
      } else {
        toggleSelect(f.id);
        state.lastSelectIndex = idx;
      }
      return;
    }
    if (act === 'preview') { openPreview(f.id); return; }
    if (act === 'pin') {
      f.pinned = !f.pinned;
      Store.updateMeta(f).then(function () { renderFiles(); });
      toast(f.pinned ? 'Fäst 📌' : 'Fästet borttaget');
      Store.logActivity('pin', f.name);
      return;
    }
    if (act === 'renameInline') {
      var nameEl = card.querySelector('.file-name');
      if (!nameEl || nameEl.querySelector('input')) return;
      var old = f.name;
      nameEl.innerHTML = '<input class="rename-input" value="' + esc(old) + '">';
      var inp = nameEl.querySelector('input');
      inp.focus(); inp.select();
      var finished = false;
      function finish(save) {
        if (finished) return;
        finished = true;
        var val = inp.value.trim();
        if (save && val && val !== old) {
          f.name = val;
          Store.updateMeta(f).then(function () { renderFiles(); renderStats(); });
          Store.logActivity('rename', old + ' → ' + val);
          toast('Namnet uppdaterat ✏️');
        } else renderFiles();
      }
      inp.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter') { ev.preventDefault(); finish(true); }
        if (ev.key === 'Escape') { ev.preventDefault(); finish(false); }
      });
      inp.addEventListener('blur', function () { finish(true); });
      return;
    }
    if (act === 'copy') {
      Store.getAdapter().getUrl(f).then(copyText).then(function () { toast('Länk kopierad 🔗'); })
        .catch(function () { toast('Kunde inte kopiera länken', 'err'); });
      return;
    }
    if (act === 'open') {
      Store.getAdapter().getUrl(f).then(function (url) { if (url) window.open(url, '_blank', 'noopener'); });
      return;
    }
    if (act === 'star') {
      f.starred = !f.starred;
      Store.updateMeta(f).then(function () { renderFiles(); });
      toast(f.starred ? 'Stjärnmärkt ★' : 'Stjärnan borttagen');
      Store.logActivity('star', f.name);
      return;
    }
    if (act === 'delete') removeFiles([f]);
  }

  /* ---------------- Kommandopalett ---------------- */
  function paletteCommands() {
    return [
      { name: 'Ladda upp filer', icon: 'upload', run: function () { $('#fileInput').click(); } },
      { name: 'Ladda upp mapp', icon: 'folder', run: function () { $('#folderInput').click(); } },
      { name: 'Växla grid / lista', icon: 'grid', run: toggleView },
      { name: 'Visa stjärnmärkta', icon: 'star', run: function () { state.filter = 'starred'; renderFiles(); } },
      { name: 'Rensa sökning och filter', icon: 'close', run: function () { state.query = ''; state.filter = 'all'; $('#searchInput').value = ''; renderFiles(); } },
      { name: 'Öppna inställningar', icon: 'settings', run: function () { openModal('settingsModal'); } },
      { name: 'Växla bakgrundsbild', icon: 'image', run: function () { theme.wallpaper = !theme.wallpaper; Store.saveSettings({ theme: { wallpaper: theme.wallpaper } }); applyTheme(); fillSettingsForm(); } },
      { name: 'Byt accentfärg', icon: 'sparkle', run: function () { var a = ['lime', 'mint', 'amber', 'violet']; theme.accent = a[(a.indexOf(theme.accent) + 1) % a.length]; Store.saveSettings({ theme: { accent: theme.accent } }); applyTheme(); fillSettingsForm(); } },
      { name: 'Exportera metadata (JSON)', icon: 'download', run: function () { downloadText('terrarium-files.json', Store.exportMetadata()); } },
      { name: 'Kortkommandon', icon: 'info', run: function () { openModal('shortcutsModal'); } },
      { name: 'Gå till filerna', icon: 'files', run: function () { $('#vault').scrollIntoView({ behavior: 'smooth' }); } },
      { name: 'Gå till projekten', icon: 'leaf', run: function () { $('#projects').scrollIntoView({ behavior: 'smooth' }); } },
      { name: 'Ladda ner alla som ZIP', icon: 'archive', run: function () { exportZip(state.files); } },
      { name: 'Visa aktivitetshistorik', icon: 'activity', run: function () { renderActivity(); openModal('activityModal'); } },
      { name: 'Rensa samlingsfilter', icon: 'sparkle', run: function () { state.collection = { type: 'all', value: '' }; renderFiles(); } },
      { name: 'Visa insikter', icon: 'chart', run: function () { renderInsights(); openModal('insightsModal'); } },
      { name: 'Visa utmärkelser', icon: 'trophy', run: function () { renderAchievements(); openModal('achievementsModal'); } },
      { name: 'Exportera metadata som CSV', icon: 'file', run: function () { downloadText('gaggo-projects.csv', Store.exportCSV()); toast('CSV exporterad'); } },
      { name: 'Växla zen-läge', icon: 'eye', run: toggleZen },
      { name: 'Öppna papperskorgen', icon: 'trash', run: function () { renderTrash(); openModal('trashModal'); } },
      { name: 'Visa dubletter', icon: 'copy', run: function () { state.collection = { type: 'duplicates', value: '' }; renderFiles(); } },
      { name: 'Byt bakgrundsbild', icon: 'image', run: function () { openModal('settingsModal'); setTimeout(function () { $('#wallpaperFile').click(); }, 120); } },
      { name: 'Byt bakgrundsstil', icon: 'sparkle', run: function () {
        var styles = ['jungle', 'night', 'amber'];
        theme.wallpaperStyle = styles[(styles.indexOf(theme.wallpaperStyle || 'jungle') + 1) % styles.length];
        Store.saveSettings({ theme: { wallpaperStyle: theme.wallpaperStyle } });
        settings = Store.settings; theme = settings.theme;
        applyTheme(); fillSettingsForm();
        toast('Bakgrund: ' + theme.wallpaperStyle + ' 🌿');
      } },
      { name: 'Skapa full backup (.zip)', icon: 'archive', run: createBackup },
      { name: 'Ladda upp från URL', icon: 'link', run: uploadFromUrl },
      { name: 'Auto-tagga alla filer', icon: 'sparkle', run: autoTagAll },
      { name: 'Starta slideshow', icon: 'image', run: toggleSlideshow },
      { name: 'Nytt textfiler', icon: 'edit', run: function () {
        var text = prompt('Skriv texten till en ny .txt-fil:');
        if (text == null || !text.trim()) return;
        var d = new Date();
        var name = 'anteckning-' + d.toISOString().slice(0, 10) + '-' + String(d.getHours()).padStart(2, '0') + String(d.getMinutes()).padStart(2, '0') + '.txt';
        uploadFiles([new File([text], name, { type: 'text/plain' })]);
      } },
      { name: 'Öppna städassistenten', icon: 'sparkle', run: function () { renderCleanup(); openModal('cleanupModal'); } },
      { name: 'Förnya alla länkar', icon: 'undo', run: function () { state.selected.clear(); state.files.forEach(function (f) { state.selected.add(f.id); }); renewSelected(); } },
      { name: 'Växla ambient-ljud', icon: 'music', run: function () { toggleAmbient(); } },
      { name: 'Skapa delningssida (HTML)', icon: 'link', run: function () {
        var chosen = state.selected.size ? selectedFiles() : state.files;
        createSharePage(chosen);
      } }
    ];
  }

  function renderPalette() {
    var q = ($('#paletteInput').value || '').trim().toLowerCase();
    var cmds = paletteCommands().filter(function (c) {
      return !q || c.name.toLowerCase().indexOf(q) >= 0 || fuzzyMatch(c.name, q);
    });
    var files = state.files.filter(function (f) {
      return q && ((f.name || '').toLowerCase().indexOf(q) >= 0 || fuzzyMatch(f.name, q));
    }).slice(0, 5).map(function (f) {
      return { name: '📄 ' + f.name, icon: 'file', run: function () { openPreview(f.id); } };
    });
    var recents = !q ? Store.getRecentCommands().map(function (name) {
      return cmds.find(function (c) { return c.name === name; });
    }).filter(Boolean).slice(0, 3).map(function (c) {
      return { name: '🕘 ' + c.name, icon: c.icon, run: c.run };
    }) : [];
    state.paletteItems = recents.concat(cmds.concat(files)).slice(0, 24);
    state.paletteIndex = Math.max(0, Math.min(state.paletteIndex, state.paletteItems.length - 1));
    var list = $('#paletteList');
    if (!list) return;
    list.innerHTML = state.paletteItems.length ? state.paletteItems.map(function (c, i) {
      return '<button class="palette-item ' + (i === state.paletteIndex ? 'active' : '') + '" data-pi="' + i + '">' +
        icon(c.icon) + '<span>' + esc(c.name) + '</span>' + (i === state.paletteIndex ? '<kbd>↵</kbd>' : '') + '</button>';
    }).join('') : '<div class="palette-empty">Inga träffar 🌫️</div>';
  }

  function openPalette() { openModal('paletteModal'); var i = $('#paletteInput'); if (i) { i.value = ''; i.focus(); } state.paletteIndex = 0; renderPalette(); }
  function runPalette(i) {
    var item = state.paletteItems[i];
    if (!item) return;
    Store.rememberCommand(item.name.replace(/^🕘 /, ''));
    closeModal('paletteModal');
    setTimeout(function () { item.run(); }, 40);
  }

  function toggleZen() {
    state.zen = !state.zen;
    document.body.classList.toggle('zen', state.zen);
    var b = $('#zenExit');
    if (b) b.hidden = !state.zen;
    toast(state.zen ? 'Zen-läge 🌿' : 'Tillbaka igen');
  }

  function toggleView() {
    state.view = state.view === 'grid' ? 'list' : 'grid';
    theme.view = state.view;
    Store.saveSettings({ theme: { view: state.view } });
    renderFiles();
    toast(state.view === 'grid' ? 'Rutnät 🔲' : 'Lista 📋');
  }

  /* ---------------- Inställningar ---------------- */
  function renderTagColors() {
    var wrap = $('#tagColorList');
    if (!wrap) return;
    var tags = {};
    state.files.forEach(function (f) { (f.tags || []).forEach(function (t) { tags[t] = 1; }); });
    var keys = Object.keys(tags).sort();
    if (!keys.length) { wrap.innerHTML = '<span class="hint">Inga taggar ännu – tagga några filer först.</span>'; return; }
    wrap.innerHTML = keys.map(function (t) {
      var color = (settings.tagColors || {})[t] || '#9bff5a';
      return '<div class="tag-color-row"><span>#' + esc(t) + '</span><input type="color" data-tag-color="' + esc(t) + '" value="' + esc(color) + '"></div>';
    }).join('');
  }

  function fillSettingsForm() {
    var s = Store.settings;
    var map = {
      setProvider: s.provider,
      setSupaUrl: s.supabase.url, setSupaKey: s.supabase.anonKey, setSupaBucket: s.supabase.bucket, setSupaSync: s.supabase.syncMetadata,
      setCloudName: s.cloudinary.cloudName, setCloudPreset: s.cloudinary.uploadPreset, setCloudFolder: s.cloudinary.folder,
      setBrandName: s.brand.name, setBrandOwner: s.brand.owner, setBrandTagline: s.brand.tagline,
      setAccent: s.theme.accent, setWallpaper: s.theme.wallpaper, setMotion: s.theme.motion, setView: s.theme.view,
      setUseCustom: s.theme.useCustom, setAccentCustom: s.theme.customAccent || '#ff6b9d',
      setCustomWallpaper: s.theme.customWallpaper, setWallpaperStyle: s.theme.wallpaperStyle || 'jungle',
      setRotateWallpapers: s.theme.rotateWallpapers, setAmbient: s.theme.ambient,
      setAutoRenew: s.theme.autoRenew !== false
    };
    Object.keys(map).forEach(function (id) {
      var el = $('#' + id); if (!el) return;
      if (el.type === 'checkbox') el.checked = !!map[id]; else el.value = map[id] == null ? '' : map[id];
    });
    var p = $('#setProvider');
    if ($('#supaFields')) $('#supaFields').hidden = p.value !== 'supabase';
    if ($('#cloudFields')) $('#cloudFields').hidden = p.value !== 'cloudinary';
  }

  function saveSettingsFromForm() {
    var v = function (id) { var e = $('#' + id); return e ? e.value.trim() : ''; };
    var patch = {
      provider: v('setProvider'),
      supabase: {
        url: v('setSupaUrl').replace(/\/$/, ''), anonKey: v('setSupaKey'),
        bucket: v('setSupaBucket') || 'vault', syncMetadata: !!($('#setSupaSync') && $('#setSupaSync').checked)
      },
      cloudinary: {
        cloudName: v('setCloudName'), uploadPreset: v('setCloudPreset') || 'terrarium_unsigned', folder: v('setCloudFolder') || 'terrarium'
      },
      brand: {
        name: v('setBrandName') || 'GaGGos Projects', owner: v('setBrandOwner') || 'GaGGo',
        tagline: v('setBrandTagline') || 'Din gröna drop för allt.'
      },
      theme: {
        accent: v('setAccent') || 'lime',
        customAccent: v('setAccentCustom') || '#ff6b9d',
        useCustom: !!($('#setUseCustom') && $('#setUseCustom').checked),
        customWallpaper: !!($('#setCustomWallpaper') && $('#setCustomWallpaper').checked),
        wallpaperStyle: v('setWallpaperStyle') || 'jungle',
        rotateWallpapers: !!($('#setRotateWallpapers') && $('#setRotateWallpapers').checked),
        ambient: !!($('#setAmbient') && $('#setAmbient').checked),
        autoRenew: !!($('#setAutoRenew') && $('#setAutoRenew').checked),
        wallpaper: !!($('#setWallpaper') && $('#setWallpaper').checked),
        motion: !!($('#setMotion') && $('#setMotion').checked), view: v('setView') || 'grid'
      }
    };
    Store.saveSettings(patch);
    settings = Store.settings; brand = settings.brand; theme = settings.theme;
    state.view = theme.view;
    applyBrand(); applyTheme(); applyWallpaper(); applyWallpaperRotation();
    if (theme.ambient && !state.ambient) toggleAmbient(true);
    if (!theme.ambient && state.ambient) toggleAmbient(false);
    closeModal('settingsModal'); boot(true);
    toast('Inställningar sparade 🌱');
    Store.logActivity('settings', patch.theme.accent + ' · ' + patch.provider);
  }

  function downloadText(name, text) {
    var blob = new Blob([text], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
  }

  /* ---------------- Bakgrund: sporer ---------------- */
  function startSpores() {
    var canvas = $('#spores');
    if (!canvas || !canvas.getContext || theme.motion === false) return;
    if (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    var ctx = canvas.getContext('2d'), dots = [], w = 0, h = 0, dpr = 1;
    function resize() {
      dpr = Math.min(2, window.devicePixelRatio || 1);
      w = window.innerWidth; h = window.innerHeight;
      canvas.width = w * dpr; canvas.height = h * dpr;
      canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    resize(); window.addEventListener('resize', resize);
    for (var i = 0; i < 52; i++) dots.push({
      x: Math.random() * w, y: Math.random() * h, r: 0.7 + Math.random() * 2.1,
      s: 0.06 + Math.random() * 0.26, drift: Math.random() * Math.PI * 2,
      a: 0.1 + Math.random() * 0.3, hue: Math.random() > 0.85 ? '#ffb347' : '#9bff5a'
    });
    function tick() {
      ctx.clearRect(0, 0, w, h);
      dots.forEach(function (d) {
        d.y -= d.s; d.drift += 0.005; d.x += Math.sin(d.drift) * 0.2;
        if (d.y < -10) { d.y = h + 10; d.x = Math.random() * w; }
        ctx.beginPath(); ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
        ctx.fillStyle = d.hue; ctx.globalAlpha = d.a; ctx.shadowBlur = 12; ctx.shadowColor = d.hue; ctx.fill();
      });
      ctx.globalAlpha = 1; ctx.shadowBlur = 0;
      requestAnimationFrame(tick);
    }
    tick();
  }

  /* ---------------- PWA ---------------- */
  function initPWA() {
    if ('serviceWorker' in navigator && /^https?:/.test(location.protocol)) {
      navigator.serviceWorker.register('sw.js').catch(function (e) { console.info('[Terrarium] SW ej registrerad:', e.message); });
    }
    window.addEventListener('beforeinstallprompt', function (e) {
      e.preventDefault(); state.installPrompt = e;
      var b = $('#installBtn'); if (b) b.hidden = false;
    });
    var install = $('#installBtn');
    install && install.addEventListener('click', function () {
      if (!state.installPrompt) return;
      state.installPrompt.prompt();
      state.installPrompt.userChoice.then(function () { state.installPrompt = null; install.hidden = true; });
    });
  }

  /* ---------------- Boot ---------------- */
  function boot(refetch) {
    var adapter = Store.getAdapter();
    if (settings.provider === 'catbox' && adapter.id !== 'catbox' && !refetch) {
      Store.checkCatbox().then(function () { boot(true); }).catch(function () { boot(true); });
      return;
    }
    applyTheme(); applyWallpaper(); applyWallpaperRotation(); applyBrand(); renderProvider(); renderProjects(); renderTrash(); renderTagColors(); loadGitHubInfo();
    var ab = $('#ambientBtn'); if (ab) ab.classList.toggle('active', !!state.ambient);
    if (!state.autoRenewStarted) { state.autoRenewStarted = true; startAutoRenew(); }
    var dot = $('#activityDot'); if (dot) dot.hidden = Store.getActivity().length === 0;
    adapter.init().then(function () { return adapter.list(); }).then(function (list) {
      var trashed = new Set(Store.getTrash().map(function (t) { return t.id; }));
      state.files = (Array.isArray(list) ? list : []).filter(function (f) { return !trashed.has(f.id); });
      renderTrash();
      renderFiles();
      state.ready = true;
      checkAchievements(true);
    }).catch(function (e) {
      console.warn('[Terrarium] Adapter-fel:', e.message);
      toast('Lagring inte ansluten: ' + e.message, 'err');
      var fallback = Store.adapters.local;
      fallback.init().then(function () { return fallback.list(); }).then(function (list) {
        var trashedIds = new Set(Store.getTrash().map(function (t) { return t.id; }));
        state.files = (list || []).filter(function (f) { return !trashedIds.has(f.id); });
        renderTrash(); renderFiles();
      });
    });
    if (refetch) renderProvider();
    setTimeout(function () { observeReveals(document); }, 80);
  }

  /* ---------------- Events ---------------- */
  function bind() {
    var input = $('#fileInput'), folderInput = $('#folderInput'), zone = $('#dropzone');

    if (zone) {
      zone.addEventListener('click', function (e) {
        if (e.target.closest('button, a')) return;
        input && input.click();
      });
      zone.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input && input.click(); }
      });
      ['dragenter', 'dragover'].forEach(function (ev) { zone.addEventListener(ev, function (e) { e.preventDefault(); zone.classList.add('drag'); }); });
      ['dragleave', 'drop'].forEach(function (ev) { zone.addEventListener(ev, function (e) { e.preventDefault(); zone.classList.remove('drag'); }); });
      zone.addEventListener('drop', function (e) {
        var items = e.dataTransfer && e.dataTransfer.items;
        if (items && items.length && items[0].webkitGetAsEntry) {
          collectDropped(items).then(function (entries) { uploadFiles(entries); });
        } else uploadFiles(e.dataTransfer && e.dataTransfer.files);
      });
    }

    function collectDropped(items) {
      var out = [];
      function readEntry(entry, prefix) {
        return new Promise(function (resolve) {
          if (entry.isFile) {
            entry.file(function (file) {
              Object.defineProperty(file, 'webkitRelativePath', { value: (prefix ? prefix + '/' : '') + file.name });
              out.push(file); resolve();
            }, resolve);
          } else if (entry.isDirectory) {
            var reader = entry.createReader(), all = [];
            (function readBatch() {
              reader.readEntries(function (entries) {
                if (!entries.length) {
                  Promise.all(all.map(function (x) { return readEntry(x, prefix ? prefix + '/' + entry.name : entry.name); })).then(resolve);
                } else { all = all.concat(Array.prototype.slice.call(entries)); readBatch(); }
              }, resolve);
            })();
          } else resolve();
        });
      }
      return Promise.all(Array.prototype.slice.call(items).map(function (it) {
        var entry = it.webkitGetAsEntry(); return entry ? readEntry(entry, '') : Promise.resolve();
      })).then(function () { return out; });
    }

    input && input.addEventListener('change', function () { uploadFiles(input.files); input.value = ''; });
    folderInput && folderInput.addEventListener('change', function () { uploadFiles(folderInput.files); folderInput.value = ''; });
    $('#folderBtn') && $('#folderBtn').addEventListener('click', function (e) { e.stopPropagation(); folderInput && folderInput.click(); });

    window.addEventListener('dragover', function (e) { e.preventDefault(); });
    window.addEventListener('drop', function (e) { if (!e.target.closest || !e.target.closest('#dropzone')) e.preventDefault(); });

    document.addEventListener('paste', function (e) {
      var tag = document.activeElement && document.activeElement.tagName;
      if (/INPUT|TEXTAREA|SELECT/.test(tag)) return;
      var items = e.clipboardData && e.clipboardData.items;
      if (!items) return;
      var files = [];
      Array.prototype.forEach.call(items, function (it) {
        if (it.kind !== 'file') return;
        var f = it.getAsFile();
        if (f) files.push(f);
      });
      if (files.length) { e.preventDefault(); uploadFiles(files); toast('Inklippt – laddar upp ' + files.length + ' fil(er)'); }
    });

    $('#fileGrid') && $('#fileGrid').addEventListener('click', onFileAction);
    $('#searchInput') && $('#searchInput').addEventListener('input', debounce(function (e) {
      state.query = e.target.value;
      var q = parseQuery(state.query);
      if (q.content) runContentSearch(q.content);
      else { state.contentToken++; state.contentMatches = null; renderFiles(); }
    }, 120));
    $('#filterBar') && $('#filterBar').addEventListener('click', function (e) {
      var chip = e.target.closest('.chip'); if (!chip) return; state.filter = chip.dataset.filter; renderFiles();
    });
    $('#collectionList') && $('#collectionList').addEventListener('dragover', function (e) {
      if (e.target.closest('[data-collection]')) e.preventDefault();
    });
    $('#collectionList') && $('#collectionList').addEventListener('drop', function (e) {
      var item = e.target.closest('[data-collection]');
      if (!item) return;
      e.preventDefault();
      var id = state.dragFileId;
      state.dragFileId = null;
      var f = findFile(id);
      if (!f) return;
      var type = item.dataset.collection, value = item.dataset.value || '';
      if (type === 'folder') f.folder = value;
      else if (type === 'tag') {
        var tags = (f.tags || []).slice();
        if (tags.indexOf(value) < 0) tags.push(value);
        f.tags = tags;
      } else { toast('Släpp på en mapp eller tagg'); return; }
      Store.updateMeta(f).then(function () { renderFiles(); });
      toast(f.name + (type === 'folder' ? ' → ' + value : ' fick #' + value));
    });
    $('#fileGrid') && $('#fileGrid').addEventListener('dragstart', function (e) {
      var card = e.target.closest('.file-card');
      if (!card) return;
      state.dragFileId = card.dataset.id;
      if (e.dataTransfer) e.dataTransfer.setData('text/plain', card.dataset.id);
    });
    $('#collectionList') && $('#collectionList').addEventListener('click', function (e) {
      var b = e.target.closest('[data-collection]'); if (!b) return;
      state.collection = { type: b.dataset.collection, value: b.dataset.value || '' };
      renderFiles();
      $('#vault').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    $('#insightsBtn') && $('#insightsBtn').addEventListener('click', function () { renderInsights(); openModal('insightsModal'); });
    $('#achievementsBtn') && $('#achievementsBtn').addEventListener('click', function () { renderAchievements(); openModal('achievementsModal'); });
    $('#activityBtn') && $('#activityBtn').addEventListener('click', function () { renderActivity(); openModal('activityModal'); });
    $('#trashBtn') && $('#trashBtn').addEventListener('click', function () { renderTrash(); openModal('trashModal'); });
    $('#ambientBtn') && $('#ambientBtn').addEventListener('click', function () { toggleAmbient(); });
    $('#cleanupBtn') && $('#cleanupBtn').addEventListener('click', function () { renderCleanup(); openModal('cleanupModal'); });
    $('#cleanupList') && $('#cleanupList').addEventListener('click', function (e) {
      if (e.target.closest('[data-merge-dups]')) { mergeDuplicates(); return; }
      var b = e.target.closest('[data-cleanup]'); if (!b) return;
      var group = cleanupGroups().find(function (g) { return g.id === b.dataset.cleanup; });
      if (!group || !group.ids.length) { toast('Inga filer i den här gruppen'); return; }
      group.ids.forEach(function (id) { state.selected.add(id); });
      renderFiles();
      toast(group.ids.length + ' fil(er) markerade');
    });
    $('#selectAllCleanup') && $('#selectAllCleanup').addEventListener('click', function () {
      state.cleanupIds.forEach(function (id) { state.selected.add(id); });
      renderFiles();
      toast(state.cleanupIds.length + ' fil(er) markerade');
    });
    $('#trashList') && $('#trashList').addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b) return;
      if (b.dataset.restore) restoreTrash(b.dataset.restore);
      if (b.dataset.purge) purgeTrash(b.dataset.purge);
    });
    $('#emptyTrash') && $('#emptyTrash').addEventListener('click', function () {
      var list = Store.getTrash();
      if (!list.length) { toast('Papperskorgen är redan tom'); return; }
      if (!confirm('Rensa ' + list.length + ' fil(er) permanent? Det går inte att ångra.')) return;
      Promise.all(list.map(function (t) { return Store.getAdapter().remove(t.meta).catch(function () {}); })).then(function () {
        localStorage.removeItem('terrarium.trash.v1');
        renderTrash(); toast('Papperskorgen rensad'); Store.logActivity('purge', list.length + ' filer');
      });
    });
    $('#zenBtn') && $('#zenBtn').addEventListener('click', toggleZen);
    $('#zenExit') && $('#zenExit').addEventListener('click', toggleZen);
    $('#applyBulkTags') && $('#applyBulkTags').addEventListener('click', function () {
      var input = $('#bulkTagInput');
      var tags = input ? input.value.split(',').map(function (x) { return x.trim().replace(/^#/, ''); }).filter(Boolean) : [];
      state.bulkTagIds.forEach(function (id) {
        var f = findFile(id);
        if (!f) return;
        var list = (f.tags || []).slice();
        tags.forEach(function (t) { if (list.indexOf(t) < 0) list.push(t); });
        f.tags = list;
        Store.updateMeta(f);
      });
      closeModal('tagModal');
      clearSelection();
      renderFiles();
      toast(tags.length ? tags.length + ' tagg(ar) tillagda 🏷️' : 'Inga taggar angavs');
      Store.logActivity('tags', tags.join(', ') || '(inga)');
    });
    $('#applyBulkRename') && $('#applyBulkRename').addEventListener('click', function () {
      var prefix = ($('#bulkPrefix').value || '').trim() || 'fil';
      var numbered = $('#bulkNumber').checked;
      state.bulkTagIds.forEach(function (id, i) {
        var f = findFile(id);
        if (!f) return;
        var ext = (f.name || '').match(/\.[^.]+$/);
        f.name = prefix + (numbered ? '-' + (i + 1) : '') + (ext ? ext[0] : '');
        Store.updateMeta(f);
      });
      closeModal('bulkRenameModal');
      clearSelection();
      renderFiles();
      toast(state.bulkTagIds.length + ' filer omdöpta ✏️');
      Store.logActivity('rename', prefix + ' · ' + state.bulkTagIds.length + ' filer');
      state.bulkTagIds = [];
    });
    $('#clearActivity') && $('#clearActivity').addEventListener('click', function () {
      localStorage.removeItem('terrarium.activity.v1');
      renderActivity(); toast('Historik rensad');
    });
    $('#sortSelect') && $('#sortSelect').addEventListener('change', function (e) { state.sort = e.target.value; renderFiles(); });
    $('#viewGrid') && $('#viewGrid').addEventListener('click', function () { if (state.view !== 'grid') toggleView(); });
    $('#viewList') && $('#viewList').addEventListener('click', function () { if (state.view !== 'list') toggleView(); });

    $('#uploadQueue') && $('#uploadQueue').addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b) return;
      if (b.dataset.cancel) {
        var id = b.dataset.cancel, q = state.queue[id], job = (state.failed[id] || {});
        state.cancelled.add(id);
        if (q && q.controller) q.controller.abort();
        if (q) q.controller = null;
        setQueueItem(id, 0, 'canceled');
      }
      if (b.dataset.retry) {
        var j = state.failed[b.dataset.retry];
        if (j) { delete state.queue[b.dataset.retry]; delete state.failed[b.dataset.retry]; startJob(j); }
      }
      if (b.dataset.queueDismiss) { delete state.queue[b.dataset.queueDismiss]; renderQueue(); }
      if (b.dataset.queueOpen) {
        var m = state.queue[b.dataset.queueOpen] && state.queue[b.dataset.queueOpen].meta;
        if (m) openPreview(m.id);
      }
    });

    $('#selectionBar') && $('#selectionBar').addEventListener('click', function (e) {
      var b = e.target.closest('[data-bulk]'); if (!b) return;
      var files = selectedFiles();
      var a = b.dataset.bulk;
      if (a === 'copy') {
        Promise.all(files.map(function (f) { return Store.getAdapter().getUrl(f); })).then(function (urls) {
          return copyText(urls.join('\n'));
        }).then(function () { toast(files.length + ' länkar kopierade 🔗'); });
      }
      if (a === 'markdown') {
        Promise.all(files.map(function (f) { return Store.getAdapter().getUrl(f); })).then(function (urls) {
          var md = files.map(function (f, i) { return '- [' + f.name + '](' + urls[i] + ')'; }).join('\n');
          return copyText(md);
        }).then(function () { toast('Markdown-lista kopierad 📝'); });
      }
      if (a === 'renew') { renewSelected(); return; }
      if (a === 'star') {
        files.forEach(function (f) { f.starred = true; Store.updateMeta(f); });
        renderFiles(); toast(files.length + ' stjärnmärkta ★');
        Store.logActivity('star', files.length + ' filer');
      }
      if (a === 'pin') {
        files.forEach(function (f) { f.pinned = true; Store.updateMeta(f); });
        renderFiles(); toast(files.length + ' filer fästa 📌');
        Store.logActivity('pin', files.length + ' filer');
      }
      if (a === 'rename') {
        state.bulkTagIds = files.map(function (f) { return f.id; });
        var rt = $('#renameTargetText');
        if (rt) rt.textContent = files.length + (files.length === 1 ? ' fil' : ' filer') + ' ska byta namn.';
        var pre = $('#bulkPrefix'); if (pre) pre.value = '';
        var num = $('#bulkNumber'); if (num) num.checked = true;
        openModal('bulkRenameModal');
        return;
      }
      if (a === 'tags') {
        state.bulkTagIds = files.map(function (f) { return f.id; });
        var target = $('#tagTargetText');
        if (target) target.textContent = files.length + (files.length === 1 ? ' fil' : ' filer') + ' får nya taggar.';
        var field = $('#bulkTagInput'); if (field) field.value = '';
        openModal('tagModal');
      }
      if (a === 'folder') {
        var folder = window.prompt('Flytta ' + files.length + ' fil(er) till mapp (namn):');
        if (folder == null) return;
        folder = folder.trim();
        files.forEach(function (f) { f.folder = folder; Store.updateMeta(f); });
        renderFiles();
        toast(folder ? files.length + ' filer flyttade till ' + folder : 'Fältet för mapp rensades');
        Store.logActivity('folder', folder || '(ingen)');
      }
      if (a === 'rename') {
        var renamed = 0;
        files.forEach(function (f) {
          var n = window.prompt('Byt namn på "' + f.name + '" (lämna tomt för att hoppa över):', f.name);
          if (n === null) return;
          n = String(n).trim().replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
          if (n && n !== f.name) { f.name = n; Store.updateMeta(f); renamed++; }
        });
        renderFiles();
        if (renamed) toast(renamed + ' fil(er) har fått nya namn ✓');
        Store.logActivity('rename', files.length + ' filer');
      }
      if (a === 'move') {
        var to = window.prompt('Mappnamn (lämna tomt för toppnivå):', '');
        if (to === null) return;
        var folder = String(to).trim();
        files.forEach(function (f) { f.folder = folder || null; Store.updateMeta(f); });
        renderFiles(); toast(files.length + ' filer flyttade ✓');
        Store.logActivity('move', files.length + ' filer');
      }
      if (a === 'duplicate') {
        var dups = files.map(function (f) { return new File([f], f.name, { type: f.type }); });
        uploadFiles(dups);
        toast(dups.length + ' filer duplicerade – startar uppladdning…');
      }
      if (a === 'download') downloadFiles(files);
      if (a === 'zip') exportZip(files);
      if (a === 'delete') removeFiles(files);
      if (a === 'clear') clearSelection();
    });

    // Preview
    $('#previewModal') && $('#previewModal').addEventListener('click', function (e) {
      if (e.target.id === 'previewModal') closeModal('previewModal');
    });
    $('#previewBody') && $('#previewBody').addEventListener('click', function (e) {
      var stage = e.target.closest('.zoomable');
      if (stage) stage.classList.toggle('zoomed');
    });
    $('#previewBody') && $('#previewBody').addEventListener('mousemove', function (e) {
      var stage = e.target.closest('.zoomable');
      if (!stage || !stage.classList.contains('zoomed')) return;
      var r = stage.getBoundingClientRect();
      stage.style.setProperty('--zx', Math.max(0, Math.min(100, (e.clientX - r.left) / r.width * 100)) + '%');
      stage.style.setProperty('--zy', Math.max(0, Math.min(100, (e.clientY - r.top) / r.height * 100)) + '%');
    });
    $('#previewPrev') && $('#previewPrev').addEventListener('click', function () { previewNav(-1); });
    $('#previewNext') && $('#previewNext').addEventListener('click', function () { previewNav(1); });
    $('#previewStar') && $('#previewStar').addEventListener('click', function () {
      var f = findFile(state.previewId); if (!f) return;
      f.starred = !f.starred; Store.updateMeta(f).then(function () { renderFiles(); renderPreview(); });
    });
    $('#previewCopy') && $('#previewCopy').addEventListener('click', function () {
      var f = findFile(state.previewId); if (!f) return;
      Store.getAdapter().getUrl(f).then(copyText).then(function () { toast('Länk kopierad 🔗'); });
    });
    $('#previewQr') && $('#previewQr').addEventListener('click', function () {
      if (state.previewId) openQr(state.previewId);
    });
    $('#qrCopy') && $('#qrCopy').addEventListener('click', function () {
      if (!state.qrUrl) return;
      copyText(state.qrUrl).then(function () { toast('Länk kopierad 🔗'); });
    });
    $('#previewDelete') && $('#previewDelete').addEventListener('click', function () {
      var f = findFile(state.previewId); if (f) removeFiles([f]);
    });
    $('#saveEdit') && $('#saveEdit').addEventListener('click', saveEdit);
    $('#slideshowBtn') && $('#slideshowBtn').addEventListener('click', toggleSlideshow);
    $('#iconPicker') && $('#iconPicker').addEventListener('click', function (e) {
      var b = e.target.closest('[data-icon]'); if (!b) return;
      var f = findFile(state.previewId); if (!f) return;
      f.icon = b.dataset.icon;
      Store.updateMeta(f).then(function () { renderFiles(); });
      toast('Ikon uppdaterad ' + f.icon);
    });
    $('#versionList') && $('#versionList').addEventListener('click', function (e) {
      var b = e.target.closest('[data-restore-version]');
      if (b) restoreVersion(Number(b.dataset.restoreVersion));
    });
    function applyImageTransform() {
      var stage = $('#zoomStage');
      if (!stage) return;
      var t = state.transform || { rot: 0, x: 1, y: 1 };
      stage.style.transform = 'rotate(' + t.rot + 'deg) scaleX(' + t.x + ') scaleY(' + t.y + ')';
    }
    $('#rotL') && $('#rotL').addEventListener('click', function () { state.transform.rot = (state.transform.rot - 90 + 360) % 360; applyImageTransform(); });
    $('#rotR') && $('#rotR').addEventListener('click', function () { state.transform.rot = (state.transform.rot + 90) % 360; applyImageTransform(); });
    $('#flipH') && $('#flipH').addEventListener('click', function () { state.transform.x *= -1; applyImageTransform(); });
    $('#flipV') && $('#flipV').addEventListener('click', function () { state.transform.y *= -1; applyImageTransform(); });
    $('#resetImg') && $('#resetImg').addEventListener('click', function () { state.transform = { rot: 0, x: 1, y: 1 }; applyImageTransform(); });
    $('#suggestTagsBtn') && $('#suggestTagsBtn').addEventListener('click', function () {
      var f = findFile(state.previewId);
      if (!f) return;
      var field = $('#editTags');
      if (field) {
        var merged = (f.tags || []).slice();
        suggestTags(f).forEach(function (t) { if (merged.indexOf(t) < 0) merged.push(t); });
        field.value = merged.join(', ');
      }
      toast('Taggar föreslagna ✨');
    });
    $('#editTags') && $('#editTags').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); saveEdit(); } });

    // Palett
    $('#paletteInput') && $('#paletteInput').addEventListener('input', function () { state.paletteIndex = 0; renderPalette(); });
    $('#paletteInput') && $('#paletteInput').addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') { e.preventDefault(); state.paletteIndex = Math.min(state.paletteItems.length - 1, state.paletteIndex + 1); renderPalette(); }
      if (e.key === 'ArrowUp') { e.preventDefault(); state.paletteIndex = Math.max(0, state.paletteIndex - 1); renderPalette(); }
      if (e.key === 'Enter') { e.preventDefault(); runPalette(state.paletteIndex); }
    });
    $('#paletteList') && $('#paletteList').addEventListener('click', function (e) {
      var b = e.target.closest('[data-pi]'); if (b) runPalette(Number(b.dataset.pi));
    });
    $('#paletteBtn') && $('#paletteBtn').addEventListener('click', openPalette);

    $$('[data-open-modal]').forEach(function (b) {
      b.addEventListener('click', function (e) { e.preventDefault(); openModal(b.dataset.openModal); });
    });
    $$('[data-close-modal]').forEach(function (b) {
      b.addEventListener('click', function () { closeModal(b.closest('.modal').id); });
    });
    $$('.modal').forEach(function (m) { m.addEventListener('click', function (e) { if (e.target === m) closeModal(m.id); }); });

    document.addEventListener('keydown', function (e) {
      var tag = document.activeElement && document.activeElement.tagName;
      var typing = /INPUT|TEXTAREA|SELECT/.test(tag);
      if (e.key === 'Escape') { if ($$('.modal.open').length) closeAllModals(); else clearSelection(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openPalette(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        if (e.shiftKey) { clearSelection(); toast('Markering rensad'); }
        else if (typeof selectAll === 'function') { selectAll(); }
        else { filteredFiles().forEach(function (f) { state.selected.add(f.id); }); renderFiles(); toast(state.selected.size + ' filer markerade'); }
        return;
      }
      if (typing) return;
      if (e.key === '/' ) { e.preventDefault(); $('#searchInput') && $('#searchInput').focus(); }
      if (e.key === '?' || (e.shiftKey && e.key === '/')) { e.preventDefault(); openModal('shortcutsModal'); }
      if (e.key === 'v' || e.key === 'V') toggleView();
      if (e.key === 'z' || e.key === 'Z') toggleZen();
      if (state.previewId) {
        if (e.key === 'ArrowLeft') previewNav(-1);
        if (e.key === 'ArrowRight') previewNav(1);
        if (e.key.toLowerCase() === 'c') { var f = findFile(state.previewId); if (f) Store.getAdapter().getUrl(f).then(copyText).then(function () { toast('Länk kopierad 🔗'); }); }
        if (e.key === 'Delete') { var f2 = findFile(state.previewId); if (f2) removeFiles([f2]); }
      }
      if (!state.previewId && (e.key === 'j' || e.key === 'J' || e.key === 'k' || e.key === 'K')) {
        var list = filteredFiles();
        if (list.length) {
          e.preventDefault();
          var cur = $$('.file-card.selected')[0];
          var idx = cur ? list.findIndex(function (f) { return f.id === cur.dataset.id; }) : -1;
          var next = e.key.toLowerCase() === 'j' ? Math.min(list.length - 1, idx + 1) : Math.max(0, idx - 1);
          openPreview(list[next].id);
        }
      }
    });

    $('#pickWallpaper') && $('#pickWallpaper').addEventListener('click', function () { $('#wallpaperFile').click(); });
    $('#wallpaperFile') && $('#wallpaperFile').addEventListener('change', function (e) {
      var file = e.target.files && e.target.files[0];
      if (!file) return;
      Store.setWallpaperBlob(file).then(function () {
        theme.customWallpaper = true;
        Store.saveSettings({ theme: { customWallpaper: true } });
        settings = Store.settings; theme = settings.theme;
        fillSettingsForm(); applyWallpaper();
        toast('Ny bakgrundsbild aktiv 🌿');
        Store.logActivity('settings', 'bakgrundsbild');
      });
      e.target.value = '';
    });
    $('#resetWallpaper') && $('#resetWallpaper').addEventListener('click', function () {
      Store.deleteWallpaperBlob().then(function () {
        theme.customWallpaper = false;
        Store.saveSettings({ theme: { customWallpaper: false } });
        settings = Store.settings; theme = settings.theme;
        fillSettingsForm(); applyWallpaper();
        toast('Bakgrunden återställd');
      });
    });
    $('#setAccentCustom') && $('#setAccentCustom').addEventListener('input', function (e) {
      var p = $('#accentPreview');
      if (p) p.style.background = 'linear-gradient(90deg,' + e.target.value + ',' + e.target.value + '99)';
    });
    $('#tagColorList') && $('#tagColorList').addEventListener('input', function (e) {
      var input = e.target.closest('[data-tag-color]');
      if (!input) return;
      settings.tagColors = settings.tagColors || {};
      settings.tagColors[input.dataset.tagColor] = input.value;
      Store.saveSettings({ tagColors: settings.tagColors });
      renderFiles();
    });
    $('#setProvider') && $('#setProvider').addEventListener('change', function () {
      $('#supaFields').hidden = $('#setProvider').value !== 'supabase';
      $('#cloudFields').hidden = $('#setProvider').value !== 'cloudinary';
    });
    $('#testConnection') && $('#testConnection').addEventListener('click', function () {
      var result = $('#connectionResult');
      if (!result) return;
      var value = function (id) { var e = $('#' + id); return e ? e.value.trim() : ''; };
      var provider = $('#setProvider').value;
      var config = {
        supabase: { url: value('setSupaUrl'), anonKey: value('setSupaKey') },
        cloudinary: { cloudName: value('setCloudName'), uploadPreset: value('setCloudPreset') }
      };
      result.className = 'hint';
      result.textContent = 'Testar anslutning…';
      Store.testConnection(provider, config).then(function (res) {
        result.textContent = res.text;
        result.className = 'hint ' + (res.ok ? 'ok' : 'err');
      });
    });
    $('#saveSettings') && $('#saveSettings').addEventListener('click', saveSettingsFromForm);
    $('#resetSettings') && $('#resetSettings').addEventListener('click', function () {
      if (!confirm('Återställ alla inställningar till standard?')) return;
      Store.resetSettings(); settings = Store.settings; brand = settings.brand; theme = settings.theme;
      state.view = theme.view; fillSettingsForm(); applyBrand(); applyTheme(); applyWallpaper(); boot(true); toast('Inställningar återställda');
    });
    $('#exportMeta') && $('#exportMeta').addEventListener('click', function () { downloadText('terrarium-files.json', Store.exportMetadata()); toast('Metadata exporterad'); });
    $('#exportCsv') && $('#exportCsv').addEventListener('click', function () { downloadText('gaggo-projects.csv', Store.exportCSV()); toast('CSV exporterad'); });
    $('#createBackup') && $('#createBackup').addEventListener('click', createBackup);
    $('#restoreBackupBtn') && $('#restoreBackupBtn').addEventListener('click', function () { $('#restoreFile').click(); });
    $('#restoreFile') && $('#restoreFile').addEventListener('change', function (e) {
      var file = e.target.files && e.target.files[0];
      if (file) restoreBackup(file);
      e.target.value = '';
    });
    $('#importMeta') && $('#importMeta').addEventListener('click', function () { $('#importFile').click(); });
    $('#importFile') && $('#importFile').addEventListener('change', function (e) {
      var file = e.target.files && e.target.files[0]; if (!file) return;
      var reader = new FileReader();
      reader.onload = function () {
        try { var n = Store.importMetadata(String(reader.result)); boot(true); toast('Importerade ' + n + ' poster'); Store.logActivity('import', n + ' poster'); }
        catch (err) { toast('Felaktig JSON-fil', 'err'); }
      };
      reader.readAsText(file); e.target.value = '';
    });

    $('#scrollUpload') && $('#scrollUpload').addEventListener('click', function () {
      $('#upload').scrollIntoView({ behavior: 'smooth', block: 'center' });
      input && input.click();
    });
    $('#howItWorks') && $('#howItWorks').addEventListener('click', function () { openModal('infoModal'); });

    function syncOnline() {
      var b = $('#offlineBanner');
      if (b) b.hidden = navigator.onLine !== false;
    }
    window.addEventListener('online', function () { syncOnline(); toast('Anslutningen är tillbaka 🌿'); });
    window.addEventListener('offline', syncOnline);
    syncOnline();
  }

  document.addEventListener('DOMContentLoaded', function () {
    bind(); fillSettingsForm(); boot(false); startSpores(); initPWA(); observeReveals(document);
  });
})();
