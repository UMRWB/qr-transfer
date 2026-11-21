const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const Q = require('../src/core.js');

function loadLib(pkg, file) {
  try { return require(pkg); } catch (e) { return require(path.join(__dirname, '..', 'node_modules', pkg, 'dist', file)); }
}
const qrcode = loadLib('qrcode-generator', 'qrcode.js');
const jsQR = loadLib('jsqr', 'jsQR.js');

function rnd(n, seed) { let a = seed >>> 0; const o = new Uint8Array(n); for (let i = 0; i < n; i++) { a = (Math.imul(a, 1664525) + 1013904223) >>> 0; o[i] = a >>> 24; } return o; }
function eq(a, b) { return a.length === b.length && a.every((v, i) => v === b[i]); }

test('crc32 known vector', () => {
  assert.strictEqual(Q.crc32(new TextEncoder().encode('123456789')), 0xCBF43926);
});

test('frame round trip and corruption', () => {
  const p = rnd(400, 1);
  const f = Q.packFrame({ session: 4242, k: 7, bs: 400, len: 2500, flags: 1, idx: 9 }, p);
  const h = Q.parseFrame(f);
  assert.ok(h); assert.strictEqual(h.session, 4242); assert.strictEqual(h.idx, 9); assert.ok(eq(h.payload, p));
  f[100] ^= 1;
  assert.strictEqual(Q.parseFrame(f), null);
  const m = Q.packFrame({ session: 1, k: 1, bs: 400, len: 1, flags: 0, idx: Q.META }, new Uint8Array(400));
  assert.strictEqual(Q.parseFrame(m).idx, 0xFFFFFFFF);
});

test('meta round trip, long name trimmed', () => {
  const m = Q.packMeta({ n: 'x'.repeat(500) + '.bin', t: 'a/b', s: 5, c: 1, h: 'ab' }, 200);
  const o = Q.parseMeta(m);
  assert.ok(o && o.t === 'a/b' && o.n.length < 200);
});

function simulate(size, bs, loss, joinLate, seed) {
  const data = rnd(size, seed);
  const enc = new Q.Encoder(data, bs, 1000 + seed);
  const h = { session: enc.session, k: enc.k, bs, len: size, flags: 0 };
  const dec = new Q.Decoder(h);
  let r = seed * 7919 + 1; const rand = () => { r = (Math.imul(r, 1103515245) + 12345) >>> 0; return r / 4294967296; };
  let idx = joinLate ? Math.floor(enc.k / 2) : 0, used = 0, seenFrames = 0;
  while (!dec.complete() && used < enc.k * 6 + 200) {
    const i = idx++;
    used++;
    if (rand() < loss) continue;
    const f = Q.parseFrame(Q.packFrame({ ...h, idx: i }, enc.payload(i)));
    assert.ok(dec.matches(f));
    dec.addFrame(f.idx, f.payload); seenFrames++;
  }
  assert.ok(dec.complete(), `incomplete size=${size} loss=${loss}`);
  assert.ok(eq(dec.assemble(), data));
  return { k: enc.k, received: seenFrames, ratio: seenFrames / enc.k };
}

test('LT decode: sizes, loss, late join', () => {
  const rows = [];
  for (const [size, bs] of [[1, 400], [400, 400], [401, 400], [800, 400], [3000, 400], [50000, 800], [300000, 1000], [3000000, 1500]]) {
    for (const loss of [0, 0.3, 0.6]) {
      for (const late of [false, true]) {
        const r = simulate(size, bs, loss, late, size % 97 + 3);
        rows.push([size, bs, loss, late, r.k, r.received, r.ratio.toFixed(3)].join(' '));
      }
    }
  }
  console.log('size bs loss late k received ratio\n' + rows.join('\n'));
});

test('QR binary round trip with real libs (all byte values)', () => {
  for (const bs of [400, 800, 1400, 2000]) {
    for (const ecc of ['L', 'M']) {
      const payload = new Uint8Array(bs); for (let i = 0; i < bs; i++) payload[i] = i & 255;
      const frame = Q.packFrame({ session: 65535, k: 3, bs, len: 5, flags: 1, idx: 2 }, payload);
      const qr = qrcode(0, ecc); qr.addData(Q.bytesToBinStr(frame), 'Byte'); qr.make();
      const n = qr.getModuleCount(), scale = 4, quiet = 4, W = (n + quiet * 2) * scale;
      const px = new Uint8ClampedArray(W * W * 4).fill(255);
      for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c))
        for (let y = 0; y < scale; y++) for (let x = 0; x < scale; x++) {
          const o = (((r + quiet) * scale + y) * W + (c + quiet) * scale + x) * 4; px[o] = px[o + 1] = px[o + 2] = 0;
        }
      const res = jsQR(px, W, W);
      assert.ok(res, `no decode bs=${bs} ecc=${ecc}`);
      const back = Q.parseFrame(Uint8Array.from(res.binaryData));
      assert.ok(back && eq(back.payload, payload), `mismatch bs=${bs} ecc=${ecc}`);
      console.log('bs', bs, 'ecc', ecc, 'qr version', (n - 17) / 4, 'modules', n, 'frame bytes', frame.length);
    }
  }
});

test('compress round trip', async () => {
  const text = new TextEncoder().encode('hello world '.repeat(5000));
  const c = await Q.compressMaybe(text);
  assert.strictEqual(c.flags, 1); assert.ok(c.data.length < text.length / 10);
  assert.ok(eq(await Q.decompress(c.data), text));
  const r = await Q.compressMaybe(rnd(5000, 9));
  assert.strictEqual(r.flags, 0);
  assert.strictEqual((await Q.sha256hex(text)).length, 64);
});
