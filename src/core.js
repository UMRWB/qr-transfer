(function (root) {
'use strict';
var MAGIC = 0x51, HDR = 16, META = 0xFFFFFFFF;

var CRC_T = (function () {
  var t = new Uint32Array(256);
  for (var n = 0; n < 256; n++) {
    var c = n;
    for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf, start, end) {
  start = start || 0;
  if (end === undefined) end = buf.length;
  var c = 0xFFFFFFFF;
  for (var i = start; i < end; i++) c = CRC_T[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function mulberry32(a) {
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    var t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

var cdfCache = {};
function degreeCdf(k) {
  if (cdfCache[k]) return cdfCache[k];
  var R = Math.max(1, 0.2 * Math.sqrt(k));
  var m = Math.min(k, Math.max(1, Math.floor(k / R)));
  var w = new Float64Array(k + 1), sum = 0, d;
  for (d = 1; d <= k; d++) {
    var rho = d === 1 ? 1 / k : 1 / (d * (d - 1));
    var tau = 0;
    if (d < m) tau = R / (d * k);
    else if (d === m) tau = 3 * R / k;
    w[d] = rho + tau;
    sum += w[d];
  }
  var cdf = new Float64Array(k + 1), acc = 0;
  for (d = 1; d <= k; d++) { acc += w[d] / sum; cdf[d] = acc; }
  cdf[k] = 1;
  cdfCache[k] = cdf;
  return cdf;
}

function pickIds(k, session, idx) {
  var seed = (Math.imul((session + 1) | 0, 0x9E3779B1) ^ Math.imul((idx + 1) | 0, 0x85EBCA6B)) >>> 0;
  var rng = mulberry32(seed);
  rng();
  var cdf = degreeCdf(k), u = rng(), d = 1;
  while (d < k && cdf[d] < u) d++;
  var ids = [], seen = new Set();
  while (ids.length < d) {
    var j = Math.floor(rng() * k);
    if (!seen.has(j)) { seen.add(j); ids.push(j); }
  }
  return ids;
}

function xorInto(dst, src) {
  for (var i = 0; i < dst.length; i++) dst[i] ^= src[i];
}

function Encoder(data, blockSize, session) {
  this.bs = blockSize;
  this.session = session & 0xFFFF;
  this.len = data.length;
  this.k = Math.max(1, Math.ceil(data.length / blockSize));
  this.padded = new Uint8Array(this.k * blockSize);
  this.padded.set(data);
}
Encoder.prototype.payload = function (idx) {
  var bs = this.bs, out = new Uint8Array(bs);
  if (idx < this.k) {
    out.set(this.padded.subarray(idx * bs, (idx + 1) * bs));
    return out;
  }
  var ids = pickIds(this.k, this.session, idx);
  for (var i = 0; i < ids.length; i++) {
    var off = ids[i] * bs;
    for (var j = 0; j < bs; j++) out[j] ^= this.padded[off + j];
  }
  return out;
};

function packFrame(h, payload) {
  var out = new Uint8Array(HDR + payload.length + 4);
  var dv = new DataView(out.buffer);
  out[0] = MAGIC;
  dv.setUint16(1, h.session);
  dv.setUint16(3, h.k);
  dv.setUint16(5, h.bs);
  dv.setUint32(7, h.len);
  out[11] = h.flags;
  dv.setUint32(12, h.idx >>> 0);
  out.set(payload, HDR);
  dv.setUint32(HDR + payload.length, crc32(out, 0, HDR + payload.length));
  return out;
}

function parseFrame(b) {
  if (!b || b.length < HDR + 5 || b[0] !== MAGIC) return null;
  var dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  var n = b.length - 4;
  if (dv.getUint32(n) !== crc32(b, 0, n)) return null;
  var h = {
    session: dv.getUint16(1), k: dv.getUint16(3), bs: dv.getUint16(5),
    len: dv.getUint32(7), flags: b[11], idx: dv.getUint32(12),
    payload: b.slice(HDR, n)
  };
  if (h.k < 1 || h.bs !== h.payload.length) return null;
  return h;
}

function packMeta(obj, bs) {
  var enc = new TextEncoder(), o = {}, key;
  for (key in obj) o[key] = obj[key];
  var json = enc.encode(JSON.stringify(o));
  while (2 + json.length > bs && o.n && o.n.length > 1) {
    o.n = o.n.slice(0, Math.max(1, o.n.length - 10));
    json = enc.encode(JSON.stringify(o));
  }
  if (2 + json.length > bs) throw new Error('block size too small for metadata');
  var out = new Uint8Array(bs);
  out[0] = json.length >> 8; out[1] = json.length & 255;
  out.set(json, 2);
  return out;
}

function parseMeta(p) {
  try {
    var n = (p[0] << 8) | p[1];
    if (n < 2 || n + 2 > p.length) return null;
    return JSON.parse(new TextDecoder().decode(p.subarray(2, 2 + n)));
  } catch (e) { return null; }
}

function Decoder(h) {
  this.session = h.session; this.k = h.k; this.bs = h.bs; this.len = h.len; this.flags = h.flags;
  this.blocks = new Array(h.k).fill(null);
  this.byBlock = new Array(h.k);
  for (var i = 0; i < h.k; i++) this.byBlock[i] = [];
  this.known = 0;
  this.seen = new Set();
}
Decoder.prototype.matches = function (h) {
  return h.session === this.session && h.k === this.k && h.bs === this.bs && h.len === this.len && h.flags === this.flags;
};
Decoder.prototype.complete = function () { return this.known === this.k; };
Decoder.prototype.addFrame = function (idx, payload) {
  if (this.complete() || this.seen.has(idx)) return false;
  this.seen.add(idx);
  var data = payload.slice();
  if (idx < this.k) { this._solve(idx, data); return true; }
  var ids = pickIds(this.k, this.session, idx), rest = [];
  for (var i = 0; i < ids.length; i++) {
    var b = this.blocks[ids[i]];
    if (b) xorInto(data, b); else rest.push(ids[i]);
  }
  if (rest.length === 0) return true;
  if (rest.length === 1) { this._solve(rest[0], data); return true; }
  var eq = { ids: rest, data: data, done: false };
  for (var j = 0; j < rest.length; j++) this.byBlock[rest[j]].push(eq);
  return true;
};
Decoder.prototype._solve = function (i, data) {
  if (this.blocks[i]) return;
  this.blocks[i] = data; this.known++;
  var queue = [i];
  while (queue.length) {
    var b = queue.pop(), list = this.byBlock[b];
    this.byBlock[b] = [];
    for (var e = 0; e < list.length; e++) {
      var eq = list[e];
      if (eq.done) continue;
      var p = eq.ids.indexOf(b);
      if (p < 0) continue;
      eq.ids.splice(p, 1);
      xorInto(eq.data, this.blocks[b]);
      if (eq.ids.length === 1) {
        eq.done = true;
        var j = eq.ids[0];
        if (!this.blocks[j]) { this.blocks[j] = eq.data; this.known++; queue.push(j); }
      } else if (eq.ids.length === 0) eq.done = true;
    }
  }
};
Decoder.prototype.assemble = function () {
  var out = new Uint8Array(this.k * this.bs);
  for (var i = 0; i < this.k; i++) out.set(this.blocks[i], i * this.bs);
  return out.subarray(0, this.len);
};

async function pipeBytes(u8, stream) {
  var s = new Blob([u8]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(s).arrayBuffer());
}
async function compressMaybe(u8) {
  if (typeof CompressionStream === 'undefined' || u8.length === 0) return { data: u8, flags: 0 };
  try {
    var c = await pipeBytes(u8, new CompressionStream('deflate-raw'));
    if (c.length < u8.length) return { data: c, flags: 1 };
  } catch (e) {}
  return { data: u8, flags: 0 };
}
async function decompress(u8) {
  return pipeBytes(u8, new DecompressionStream('deflate-raw'));
}
async function sha256hex(u8) {
  var c = root.crypto;
  if (!c || !c.subtle) return null;
  try {
    var d = new Uint8Array(await c.subtle.digest('SHA-256', u8)), s = '';
    for (var i = 0; i < d.length; i++) s += (d[i] < 16 ? '0' : '') + d[i].toString(16);
    return s;
  } catch (e) { return null; }
}
function bytesToBinStr(u8) {
  var s = '';
  for (var i = 0; i < u8.length; i += 8192) s += String.fromCharCode.apply(null, u8.subarray(i, i + 8192));
  return s;
}

var API = {
  META: META, HDR: HDR, crc32: crc32, pickIds: pickIds, Encoder: Encoder, Decoder: Decoder,
  packFrame: packFrame, parseFrame: parseFrame, packMeta: packMeta, parseMeta: parseMeta,
  compressMaybe: compressMaybe, decompress: decompress, sha256hex: sha256hex, bytesToBinStr: bytesToBinStr
};
root.QRT = API;
if (typeof module === 'object' && module.exports) module.exports = API;
})(typeof self !== 'undefined' ? self : globalThis);
