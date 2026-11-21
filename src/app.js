(function () {
'use strict';
var Q = window.QRT;
function $(id) { return document.getElementById(id); }
function fmt(n) { return n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(2) + ' MB'; }
function fmtT(s) { s = Math.round(s); return s >= 60 ? Math.floor(s / 60) + 'm ' + (s % 60) + 's' : s + 's'; }

var tabs = { send: $('tab-send'), recv: $('tab-recv') }, panels = { send: $('panel-send'), recv: $('panel-recv') };
function showTab(name) {
  for (var k in tabs) { tabs[k].classList.toggle('active', k === name); panels[k].hidden = k !== name; }
  if (name !== 'send') stopSend();
  if (name !== 'recv') stopCam();
}
tabs.send.onclick = function () { showTab('send'); };
tabs.recv.onclick = function () { showTab('recv'); };

/* ---------- SEND ---------- */
var src = null, run = null;
var cvs = $('qr'), ctx = cvs.getContext('2d');
var off = document.createElement('canvas'), octx = off.getContext('2d');

function setSource(name, type, raw) {
  $('s-info').textContent = 'Preparing...';
  stopSend();
  Promise.all([Q.compressMaybe(raw), Q.sha256hex(raw)]).then(function (r) {
    src = { name: name, type: type || 'application/octet-stream', size: raw.length, data: r[0].data, flags: r[0].flags, sha: r[1] };
    src.crc = Q.crc32(src.data);
    updateInfo();
    $('s-start').disabled = false;
  }, function (e) { $('s-info').textContent = 'Error: ' + e.message; });
}
function bsVal() { return parseInt($('s-bs').value, 10); }
function fpsVal() { return parseInt($('s-fps').value, 10); }
function updateInfo() {
  if (!src) return;
  var bs = bsVal(), k = Math.max(1, Math.ceil(src.data.length / bs)), fps = fpsVal();
  var secs = (k * 1.2 + k / 9) / fps;
  $('s-info').textContent = src.name + ': ' + fmt(src.size) + (src.flags ? ' -> ' + fmt(src.data.length) + ' compressed' : ' (not compressible)') +
    ' | ' + k + ' blocks | est. ' + fmtT(secs) + ' at ' + fps + ' fps if the camera reads cleanly';
}
$('s-bs').onchange = $('s-fps').onchange = function () { updateInfo(); if (run) startSend(); };
$('s-ecc').onchange = function () { if (run) startSend(); };
$('s-file').onchange = function (e) {
  var f = e.target.files[0];
  if (!f) return;
  f.arrayBuffer().then(function (b) { setSource(f.name, f.type, new Uint8Array(b)); });
};
$('s-test').onclick = function () {
  var raw = new Uint8Array(50000), a = 12345;
  for (var i = 0; i < raw.length; i++) { a = (Math.imul(a, 1664525) + 1013904223) >>> 0; raw[i] = a >>> 24; }
  setSource('benchmark-50KB.bin', 'application/octet-stream', raw);
};

function renderTo(bytes) {
  var qr = window.qrcode(0, $('s-ecc').value);
  qr.addData(Q.bytesToBinStr(bytes), 'Byte');
  qr.make();
  var n = qr.getModuleCount(), q = 4, total = n + q * 2;
  var dpr = window.devicePixelRatio || 1;
  var avail = Math.min(cvs.parentNode.clientWidth, window.innerHeight * (document.fullscreenElement ? 0.98 : 0.7));
  var cell = Math.max(2, Math.floor(avail * dpr / total)), px = cell * total;
  off.width = px; off.height = px;
  octx.fillStyle = '#fff'; octx.fillRect(0, 0, px, px);
  octx.fillStyle = '#000';
  for (var r = 0; r < n; r++) for (var c = 0; c < n; c++) if (qr.isDark(r, c)) octx.fillRect((c + q) * cell, (r + q) * cell, cell, cell);
  return { w: px, css: px / dpr, version: (n - 17) / 4 };
}

function nextBytes() {
  var r = run, t = r.t++, f;
  if (t % 10 === 0) f = { idx: Q.META, payload: r.meta };
  else { var i = r.di++; f = { idx: i, payload: r.enc.payload(i) }; }
  return Q.packFrame({ session: r.enc.session, k: r.enc.k, bs: r.bs, len: src.data.length, flags: src.flags, idx: f.idx }, f.payload);
}
function prepare() {
  if (!run) return;
  try { run.ready = renderTo(nextBytes()); }
  catch (e) { $('s-info').textContent = 'Error: ' + (e.message || e) + ' (try a smaller block size)'; stopSend(); }
}
function startSend() {
  if (!src) return;
  stopSend(true);
  var bs = bsVal();
  var session = Math.floor(Math.random() * 65536);
  var enc = new Q.Encoder(src.data, bs, session);
  var meta = { n: src.name, t: src.type, s: src.size, c: src.crc };
  if (src.sha) meta.h = src.sha;
  run = { enc: enc, bs: bs, meta: Q.packMeta(meta, bs), t: 0, di: 0, ready: null, last: 0, shown: 0, t0: performance.now(), raf: 0 };
  $('s-stop').disabled = false; $('s-full').disabled = false;
  if (navigator.wakeLock) navigator.wakeLock.request('screen').then(function (l) { if (run) run.lock = l; else l.release(); }, function () {});
  prepare();
  if (!run) return;
  run.raf = requestAnimationFrame(tick);
}
function tick(ts) {
  if (!run) return;
  var iv = 1000 / fpsVal();
  if (run.ready && ts - run.last >= iv - 3) {
    var rd = run.ready; run.ready = null; run.last = ts;
    cvs.width = rd.w; cvs.height = rd.w; cvs.style.width = rd.css + 'px'; cvs.style.height = rd.css + 'px';
    ctx.drawImage(off, 0, 0);
    run.shown++;
    var el = (performance.now() - run.t0) / 1000;
    var eff = run.shown / el;
    $('s-stat').textContent = 'QR v' + rd.version + ' | frame ' + run.shown + ' | ' + eff.toFixed(1) + ' fps effective | ~' + (eff * run.bs / 1000).toFixed(1) + ' KB/s raw | pass ' + (run.di / run.enc.k).toFixed(2);
    setTimeout(prepare, 0);
  }
  run.raf = requestAnimationFrame(tick);
}
function stopSend(keep) {
  if (run) { cancelAnimationFrame(run.raf); if (run.lock) run.lock.release(); run = null; }
  if (!keep) { $('s-stop').disabled = true; $('s-full').disabled = true; if (document.fullscreenElement) document.exitFullscreen(); }
}
$('s-start').onclick = startSend;
$('s-stop').onclick = function () { stopSend(); };
$('s-full').onclick = function () { var e = $('qr-wrap'); if (e.requestFullscreen) e.requestFullscreen(); else if (e.webkitRequestFullscreen) e.webkitRequestFullscreen(); };

/* ---------- RECEIVE ---------- */
var stream = null, scanning = false, dec = null, meta = null, st = null, result = null;
var video = $('video'), scv = document.createElement('canvas'), sctx = scv.getContext('2d', { willReadFrequently: true });
var grid = $('grid'), gctx = grid.getContext('2d');

function resetRecv() {
  dec = null; meta = null; result = null;
  st = { ok: 0, bad: 0, dup: 0, mismatch: 0, t0: 0, tFirst: 0 };
  $('r-result').hidden = true; $('r-status').textContent = scanning ? 'Point the camera at the QR code.' : 'Camera off.';
  grid.width = 1; grid.height = 1;
  $('r-bar').style.width = '0%';
}
resetRecv();

function startCam() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    $('r-status').textContent = 'Camera not available. This page must be opened over HTTPS (or localhost).';
    return;
  }
  var h = parseInt($('r-res').value, 10);
  navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: h * 16 / 9 }, height: { ideal: h } } }).then(function (s) {
    stream = s; video.srcObject = s; video.setAttribute('playsinline', '');
    return video.play();
  }).then(function () {
    scanning = true; $('r-start').hidden = true; $('r-stop').hidden = false;
    resetRecv(); scan();
  }, function (e) { $('r-status').textContent = 'Camera error: ' + e.message; });
}
function stopCam() {
  scanning = false;
  if (stream) { stream.getTracks().forEach(function (t) { t.stop(); }); stream = null; }
  video.srcObject = null;
  $('r-start').hidden = false; $('r-stop').hidden = true;
}
$('r-start').onclick = startCam;
$('r-stop').onclick = function () { stopCam(); $('r-status').textContent = 'Camera off.'; };
$('r-reset').onclick = function () { resetRecv(); };

var lastUi = 0;
function scan() {
  if (!scanning) return;
  var w = video.videoWidth, h = video.videoHeight;
  if (w && h && video.readyState >= 2) {
    var sc = Math.min(1, 1600 / w), cw = Math.round(w * sc), ch = Math.round(h * sc);
    if (scv.width !== cw || scv.height !== ch) { scv.width = cw; scv.height = ch; }
    sctx.drawImage(video, 0, 0, cw, ch);
    var img = sctx.getImageData(0, 0, cw, ch);
    var r = window.jsQR(img.data, cw, ch, { inversionAttempts: 'dontInvert' });
    if (r && r.binaryData && !result) onBytes(Uint8Array.from(r.binaryData));
  }
  requestAnimationFrame(scan);
}

function onBytes(b) {
  var f = Q.parseFrame(b);
  if (!f) { st.bad++; return; }
  if (!dec) {
    dec = new Q.Decoder(f); st.tFirst = performance.now(); meta = null;
  } else if (!dec.matches(f)) {
    if (++st.mismatch >= 12) { resetRecv(); dec = new Q.Decoder(f); st.tFirst = performance.now(); }
    else return;
  }
  st.mismatch = 0;
  if (f.idx === Q.META) { if (!meta) meta = Q.parseMeta(f.payload); }
  else if (dec.addFrame(f.idx, f.payload)) st.ok++; else st.dup++;
  var now = performance.now();
  if (now - lastUi > 120 || dec.complete()) { lastUi = now; drawProgress(); }
  if (dec.complete() && meta && !result) finish();
}

function drawProgress() {
  if (!dec) return;
  var k = dec.k, cols = Math.ceil(Math.sqrt(k * 4)), rows = Math.ceil(k / cols);
  if (grid.width !== cols || grid.height !== rows) { grid.width = cols; grid.height = rows; }
  var im = gctx.createImageData(cols, rows), d = im.data;
  for (var i = 0; i < cols * rows; i++) {
    var o = i * 4, have = i < k && dec.blocks[i];
    d[o] = have ? 46 : 40; d[o + 1] = have ? 204 : 44; d[o + 2] = have ? 113 : 52; d[o + 3] = i < k ? 255 : 0;
  }
  gctx.putImageData(im, 0, 0);
  $('r-bar').style.width = (100 * dec.known / k).toFixed(1) + '%';
  $('r-status').textContent = dec.known + ' / ' + dec.k + ' blocks | frames ok ' + st.ok + ', dup ' + st.dup + ', unreadable ' + st.bad +
    (meta ? ' | ' + meta.n : ' | waiting for file info...');
}

function finish() {
  var t = (performance.now() - st.tFirst) / 1000;
  var data = dec.assemble();
  var p = Q.crc32(data) === meta.c ? Promise.resolve() : Promise.reject(new Error('Checksum mismatch'));
  p.then(function () { return dec.flags & 1 ? Q.decompress(data) : data; }).then(function (out) {
    if (out.length !== meta.s) throw new Error('Size mismatch');
    return Q.sha256hex(out).then(function (h) {
      if (h && meta.h && h !== meta.h) throw new Error('SHA-256 mismatch');
      return { out: out, verified: !!(h && meta.h) };
    });
  }).then(function (r) {
    var blob = new Blob([r.out], { type: meta.t || 'application/octet-stream' });
    var url = URL.createObjectURL(blob);
    result = { blob: blob, url: url, name: meta.n || 'received.bin' };
    $('r-result').hidden = false;
    $('r-done').textContent = 'Received ' + result.name + ' (' + fmt(r.out.length) + ') in ' + fmtT(t) + ' | ' + (data.length / 1000 / Math.max(t, 0.1)).toFixed(1) + ' KB/s | ' + (r.verified ? 'SHA-256 verified' : 'CRC32 verified');
    var a = $('r-dl'); a.href = url; a.download = result.name;
    $('r-share').hidden = !(navigator.canShare && navigator.canShare({ files: [new File([blob], result.name, { type: blob.type })] }));
    $('r-status').textContent = 'Done.';
    stopCam();
  }).catch(function (e) {
    $('r-status').textContent = 'Failed: ' + e.message + ' (tap Reset and try again)';
    result = null; dec = null;
  });
}
$('r-share').onclick = function () {
  if (result) navigator.share({ files: [new File([result.blob], result.name, { type: result.blob.type })] }).catch(function () {});
};

if (!window.isSecureContext && location.protocol !== 'file:') $('r-warn').hidden = false;
if (typeof CompressionStream === 'undefined') $('s-warn').hidden = false;
})();
