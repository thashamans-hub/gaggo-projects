/* ============================================================
   TERRARIUM ZIP READER – läser ZIP:ar som använder store-metoden
   (vilket är formatet våra egna backups använder).
   Exponerar: window.TerrariumZipReader.read(ArrayBuffer) -> {name: Uint8Array}
   ============================================================ */
(function () {
  'use strict';

  function read(buffer) {
    var bytes = new Uint8Array(buffer);
    var dv = new DataView(buffer);
    if (bytes.length < 22) throw new Error('Filen är för liten för att vara en ZIP');

    var eocd = -1;
    for (var i = bytes.length - 22; i >= Math.max(0, bytes.length - 65558); i--) {
      if (dv.getUint32(i, true) === 0x06054B50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('Ingen ZIP-slutkatalog hittades');

    var count = dv.getUint16(eocd + 10, true);
    var cdOffset = dv.getUint32(eocd + 16, true);
    var out = {};
    var pos = cdOffset;

    for (var n = 0; n < count; n++) {
      if (dv.getUint32(pos, true) !== 0x02014B50) throw new Error('Ogiltig central katalog');
      var method = dv.getUint16(pos + 10, true);
      var compSize = dv.getUint32(pos + 20, true);
      var nameLen = dv.getUint16(pos + 28, true);
      var extraLen = dv.getUint16(pos + 30, true);
      var commentLen = dv.getUint16(pos + 32, true);
      var localOffset = dv.getUint32(pos + 42, true);
      var nameBytes = bytes.subarray(pos + 46, pos + 46 + nameLen);
      var name = decodeName(nameBytes);

      if (method === 0) {
        if (dv.getUint32(localOffset, true) !== 0x04034B50) throw new Error('Ogiltig lokal filheader');
        var lNameLen = dv.getUint16(localOffset + 26, true);
        var lExtraLen = dv.getUint16(localOffset + 28, true);
        var start = localOffset + 30 + lNameLen + lExtraLen;
        out[name] = bytes.slice(start, start + compSize);
      }

      pos += 46 + nameLen + extraLen + commentLen;
      if (pos >= bytes.length) break;
    }
    return out;
  }

  function decodeName(bytes) {
    if (typeof TextDecoder !== 'undefined') return new TextDecoder('utf-8').decode(bytes);
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return s;
  }

  function text(entries, name) {
    var data = entries[name];
    if (!data) return null;
    if (typeof TextDecoder !== 'undefined') return new TextDecoder('utf-8').decode(data);
    return String.fromCharCode.apply(null, data);
  }

  window.TerrariumZipReader = { read: read, text: text };
})();
