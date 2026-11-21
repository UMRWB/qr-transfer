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
var src = null, run = null, bench = null, lastSession = -1;
var cvs = $('qr'), ctx = cvs.getContext('2d');
var off = document.createElement('canvas'), octx = off.getContext('2d');
var PRESETS = [[400, 1], [800, 1], [1400, 1], [2000, 1], [800, 2], [1400, 2]], STEP_MS = 30000;

function setSource(name, type, raw) {
  $('s-info').textContent = 'Preparing...';
  stopSend();
  return Promise.all([Q.compressMaybe(raw), Q.sha256hex(raw)]).then(function (r) {
    src = { name: name, type: type || 'application/octet-stream', size: raw.length, data: r[0].data, flags: r[0].flags, sha: r[1] };
    src.crc = Q.crc32(src.data);
    updateInfo();
    $('s-start').disabled = false;
    return true;
  }, function (e) { $('s-info').textContent = 'Error: ' + e.message; return false; });
}
function bsVal() { return parseInt($('s-bs').value, 10); }
function fpsVal() { return parseInt($('s-fps').value, 10); }
function lanesVal() { return parseInt($('s-lanes').value, 10) === 2 ? 2 : 1; }
function updateInfo() {
  if (!src) return;
  var bs = bsVal(), k = Math.max(1, Math.ceil(src.data.length / bs)), rate = fpsVal() * lanesVal();
  var secs = (k * 1.2 + k / 9) / rate;
  $('s-info').textContent = src.name + ': ' + fmt(src.size) + (src.flags ? ' -> ' + fmt(src.data.length) + ' compressed' : ' (not compressible)') +
    ' | ' + k + ' blocks | est. ' + fmtT(secs) + ' at ' + rate + ' codes/s if the camera reads cleanly';
}
$('s-bs').onchange = $('s-fps').onchange = $('s-lanes').onchange = function () { updateInfo(); if (run) startSend(); };
$('s-ecc').onchange = function () { if (run) startSend(); };
$('s-file').onchange = function (e) {
  var f = e.target.files[0];
  if (!f) return;
  f.arrayBuffer().then(function (b) { setSource(f.name, f.type, new Uint8Array(b)); });
};
function testBytes() {
  var raw = new Uint8Array(50000), a = 12345;
  for (var i = 0; i < raw.length; i++) { a = (Math.imul(a, 1664525) + 1013904223) >>> 0; raw[i] = a >>> 24; }
  return raw;
}
$('s-test').onclick = function () { setSource('benchmark-50KB.bin', 'application/octet-stream', testBytes()); };

function renderTo(bytes) {
  var qr = window.qrcode(0, $('s-ecc').value);
  qr.addData(Q.bytesToBinStr(bytes), 'Byte');
  qr.make();
  var lanes = run ? run.lanes : 1;
  var n = qr.getModuleCount(), q = 4, total = n + q * 2;
  var dpr = window.devicePixelRatio || 1;
  var avail = Math.min(cvs.parentNode.clientWidth / lanes, window.innerHeight * (document.fullscreenElement ? 0.98 : 0.7));
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
  var bs = bsVal(), lanes = lanesVal();
  var session;
  do { session = Math.floor(Math.random() * 65536); } while (session === lastSession);
  lastSession = session;
  var enc = new Q.Encoder(src.data, bs, session);
  var meta = { n: src.name, t: src.type, s: src.size, c: src.crc, l: lanes };
  if (src.sha) meta.h = src.sha;
  run = {
    enc: enc, bs: bs, lanes: lanes, meta: Q.packMeta(meta, bs), t: 0, di: 0, ready: null, lane: 0,
    warm: [], lastTs: 0, refMs: 0, hold: 0, since: 0, shown: 0, missed: 0, tShow0: 0, ver: 0, raf: 0
  };
  $('s-stop').disabled = false; $('s-full').disabled = false;
  if (navigator.wakeLock) navigator.wakeLock.request('screen').then(function (l) { if (run) run.lock = l; else l.release(); }, function () {});
  prepare();
  if (!run) return;
  run.raf = requestAnimationFrame(tick);
}
function show() {
  var r = run, rd = r.ready;
  r.ready = null;
  var W = rd.w * r.lanes;
  if (cvs.width !== W || cvs.height !== rd.w) {
    cvs.width = W; cvs.height = rd.w;
    cvs.style.width = (rd.css * r.lanes) + 'px'; cvs.style.height = rd.css + 'px';
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, rd.w);
  }
  ctx.drawImage(off, r.lane * rd.w, 0);
  r.lane = (r.lane + 1) % r.lanes;
  r.ver = rd.version;
  if (!r.shown) r.tShow0 = performance.now();
  r.shown++;
}
function senderStats() {
  var r = run, now = performance.now();
  var codes = 1000 / (r.refMs * r.hold), nominal = codes * r.bs / 1000;
  var el = Math.max((now - r.tShow0) / 1000, 0.001), eff = Math.max(r.shown - 1, 0) / el;
  $('s-stat').textContent = (bench ? 'Benchmark step ' + (bench.i + 1) + '/' + PRESETS.length + ' | ' : '') +
    'QR v' + r.ver + ' x' + r.lanes + ' lane' + (r.lanes > 1 ? 's' : '') + ' | hold ' + r.hold + ' refresh @ ' + (1000 / r.refMs).toFixed(0) + ' Hz = ' + codes.toFixed(1) + ' codes/s' +
    ' | nominal ' + nominal.toFixed(1) + ' KB/s | shown ' + eff.toFixed(1) + ' codes/s (' + (eff * r.bs / 1000).toFixed(1) + ' KB/s) | late ' + r.missed +
    ' | pass ' + (r.di / r.enc.k).toFixed(2);
}
function tick(ts) {
  var r = run;
  if (!r) return;
  if (r.lastTs && r.warm.length < 30) {
    var d = ts - r.lastTs;
    if (d > 2 && d < 60) r.warm.push(d);
  }
  r.lastTs = ts;
  if (!r.hold) {
    if (r.warm.length >= 30) {
      var s = r.warm.slice().sort(function (a, b) { return a - b; });
      r.refMs = s[15];
      r.hold = Math.max(1, Math.round((1000 / (fpsVal() * r.lanes)) / r.refMs));
    }
  } else {
    r.since++;
    if (r.since >= r.hold) {
      if (r.ready) {
        show(); r.since = 0;
        senderStats();
        setTimeout(prepare, 0);
      } else r.missed++;
    }
  }
  if (run === r) r.raf = requestAnimationFrame(tick);
}
function stopSend(keep) {
  if (run) { cancelAnimationFrame(run.raf); if (run.lock) run.lock.release(); run = null; }
  if (!keep) {
    if (bench) { clearTimeout(bench.timer); bench = null; }
    $('s-stop').disabled = true; $('s-full').disabled = true;
    if (document.fullscreenElement) document.exitFullscreen();
  }
}
$('s-start').onclick = startSend;
$('s-stop').onclick = function () { stopSend(); };
$('s-full').onclick = function () { var e = $('qr-wrap'); if (e.requestFullscreen) e.requestFullscreen(); else if (e.webkitRequestFullscreen) e.webkitRequestFullscreen(); };

function benchStep(i) {
  if (!bench) return;
  if (i >= PRESETS.length) {
    stopSend();
    $('s-stat').textContent = 'Benchmark sweep finished. Read the results table on the phone.';
    return;
  }
  bench.i = i;
  $('s-bs').value = String(PRESETS[i][0]); $('s-lanes').value = String(PRESETS[i][1]);
  updateInfo();
  startSend();
  if (!run) { bench = null; return; }
  bench.timer = setTimeout(function () { benchStep(i + 1); }, STEP_MS);
}
$('s-bench').onclick = function () {
  setSource('benchmark-50KB.bin', 'application/octet-stream', testBytes()).then(function (ok) {
    if (!ok) return;
    bench = { i: 0, timer: 0 };
    benchStep(0);
  });
};

/* ---------- RECEIVE ---------- */
var stream = null, scanning = false, dec = null, meta = null, st = null, result = null, finishing = false, doneSession = -1;
var hist = [], ev = null, decMs = [], camFrame = true, hasRVFC = false, lastScanT = 0, statTimer = 0, lastUi = 0;
var video = $('video'), scv = document.createElement('canvas'), sctx = scv.getContext('2d', { willReadFrequently: true });
var grid = $('grid'), gctx = grid.getContext('2d');

function newEv() { return { scan: [], cam: [], dec: [], ok: [], bad: [], neu: [] }; }
function newSt() { return { ok: 0, bad: 0, dup: 0, mismatch: 0, tFirst: performance.now() }; }
function benchOn() { return $('r-bench').checked; }

function resetRecv() {
  dec = null; meta = null; result = null; finishing = false; doneSession = -1;
  st = newSt(); ev = newEv(); decMs = [];
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
    resetRecv();
    hasRVFC = typeof video.requestVideoFrameCallback === 'function';
    camFrame = true; lastScanT = 0;
    if (hasRVFC) {
      var cb = function () {
        camFrame = true; ev.cam.push(performance.now());
        if (scanning) video.requestVideoFrameCallback(cb);
      };
      video.requestVideoFrameCallback(cb);
    }
    clearInterval(statTimer); statTimer = setInterval(updStats, 500);
    scan();
  }, function (e) { $('r-status').textContent = 'Camera error: ' + e.message; });
}
function stopCam() {
  scanning = false;
  clearInterval(statTimer);
  if (stream) { stream.getTracks().forEach(function (t) { t.stop(); }); stream = null; }
  video.srcObject = null;
  $('r-start').hidden = false; $('r-stop').hidden = true;
}
$('r-start').onclick = startCam;
$('r-stop').onclick = function () { stopCam(); $('r-status').textContent = 'Camera off.'; };
$('r-reset').onclick = function () { resetRecv(); };
$('r-clear').onclick = function () { hist = []; renderHist(); };

function wantTwo() { return meta ? (parseInt(meta.l, 10) || 1) > 1 : true; }
function blank(d, w, h, loc) {
  var xs = [loc.topLeftCorner.x, loc.topRightCorner.x, loc.bottomLeftCorner.x, loc.bottomRightCorner.x];
  var ys = [loc.topLeftCorner.y, loc.topRightCorner.y, loc.bottomLeftCorner.y, loc.bottomRightCorner.y];
  var x0 = Math.min.apply(null, xs), x1 = Math.max.apply(null, xs), y0 = Math.min.apply(null, ys), y1 = Math.max.apply(null, ys);
  var pad = 0.08 * (x1 - x0);
  x0 = Math.max(0, Math.floor(x0 - pad)); x1 = Math.min(w - 1, Math.ceil(x1 + pad));
  y0 = Math.max(0, Math.floor(y0 - pad)); y1 = Math.min(h - 1, Math.ceil(y1 + pad));
  for (var y = y0; y <= y1; y++) d.fill(255, (y * w + x0) * 4, (y * w + x1) * 4 + 4);
}

function scan() {
  if (!scanning) return;
  var now0 = performance.now();
  if (hasRVFC && !camFrame && now0 - lastScanT < 250) { requestAnimationFrame(scan); return; }
  camFrame = false; lastScanT = now0;
  var w = video.videoWidth, h = video.videoHeight;
  if (w && h && video.readyState >= 2) {
    var sc = Math.min(1, 1600 / w), cw = Math.round(w * sc), ch = Math.round(h * sc);
    if (scv.width !== cw || scv.height !== ch) { scv.width = cw; scv.height = ch; }
    sctx.drawImage(video, 0, 0, cw, ch);
    var img = sctx.getImageData(0, 0, cw, ch);
    var opt = { inversionAttempts: 'dontInvert' };
    var got = [];
    var r = window.jsQR(img.data, cw, ch, opt);
    if (r && r.binaryData) {
      got.push(Uint8Array.from(r.binaryData));
      if (wantTwo() && r.location) {
        blank(img.data, cw, ch, r.location);
        var r2 = window.jsQR(img.data, cw, ch, opt);
        if (r2 && r2.binaryData) got.push(Uint8Array.from(r2.binaryData));
      }
    }
    var t1 = performance.now();
    decMs.push(t1 - now0); if (decMs.length > 120) decMs.shift();
    ev.scan.push(t1);
    if (!result) for (var i = 0; i < got.length; i++) onBytes(got[i]);
  }
  requestAnimationFrame(scan);
}

function beginSession(f) {
  dec = new Q.Decoder(f); meta = null; st = newSt(); doneSession = -1;
}
function onBytes(b) {
  var now = performance.now();
  ev.dec.push(now);
  var f = Q.parseFrame(b);
  if (!f) { st.bad++; ev.bad.push(now); return; }
  if (f.session === doneSession) return;
  if (!dec) beginSession(f);
  else if (!dec.matches(f)) {
    if (++st.mismatch >= 12) { pushHist(false, (now - st.tFirst) / 1000); beginSession(f); }
    else return;
  }
  st.mismatch = 0; ev.ok.push(now);
  if (f.idx === Q.META) { if (!meta) meta = Q.parseMeta(f.payload); }
  else if (dec.addFrame(f.idx, f.payload)) { st.ok++; ev.neu.push(now); } else st.dup++;
  if (now - lastUi > 120 || dec.complete()) { lastUi = now; drawProgress(); }
  if (dec.complete() && meta && !result && !finishing) finish();
}

function pushHist(done, secs) {
  if (!dec || (!done && dec.known === 0)) return;
  hist.push({ bs: dec.bs, lanes: meta ? (parseInt(meta.l, 10) || 1) : 0, k: dec.k, known: dec.known, secs: secs, done: done, bytes: dec.len });
  renderHist();
}
function renderHist() {
  $('r-clear').hidden = !hist.length;
  if (!hist.length) { $('r-hist').innerHTML = ''; return; }
  var rows = '<tr><th>Block</th><th>Lanes</th><th>Result</th><th>Time</th><th>KB/s</th></tr>';
  for (var i = 0; i < hist.length; i++) {
    var h = hist[i], t = Math.max(h.secs, 0.1);
    var res = h.done ? 'complete' : 'partial ' + h.known + '/' + h.k;
    var kbs = h.done ? h.bytes / 1000 / t : h.known * h.bs / 1000 / t;
    rows += '<tr><td>' + (h.bs | 0) + ' B</td><td>' + (h.lanes || '?') + '</td><td>' + res + '</td><td>' + t.toFixed(1) + ' s</td><td>' + kbs.toFixed(1) + '</td></tr>';
  }
  $('r-hist').innerHTML = '<table>' + rows + '</table>';
}

function rate(a, now, win) { while (a.length && a[0] < now - win) a.shift(); return a.length / win; }
function pct(a, p) {
  if (!a.length) return 0;
  var s = a.slice().sort(function (x, y) { return x - y; });
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
}
function updStats() {
  if (!scanning || !ev) return;
  var now = performance.now(), w = 5;
  var cam = hasRVFC ? rate(ev.cam, now, w).toFixed(1) : 'n/a';
  var neu = rate(ev.neu, now, w), bs = dec ? dec.bs : 0;
  $('r-stats').textContent = 'camera ' + cam + ' fps | scans ' + rate(ev.scan, now, w).toFixed(1) + '/s | decoded ' + rate(ev.dec, now, w).toFixed(1) + '/s | valid ' +
    rate(ev.ok, now, w).toFixed(1) + '/s | CRC-bad ' + rate(ev.bad, now, w).toFixed(1) + '/s | new blocks ' + neu.toFixed(1) + '/s | goodput ' + (neu * bs / 1000).toFixed(1) +
    ' KB/s (5 s avg) | scan ms p50 ' + pct(decMs, 0.5).toFixed(0) + ', p95 ' + pct(decMs, 0.95).toFixed(0);
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
  finishing = true;
  var t = (performance.now() - st.tFirst) / 1000;
  var data = dec.assemble();
  var crcOk = Q.crc32(data) === meta.c;
  if (benchOn()) {
    pushHist(crcOk, t);
    doneSession = dec.session; dec = null; meta = null; finishing = false;
    $('r-status').textContent = (crcOk ? 'Step complete in ' + fmtT(t) : 'Step failed checksum') + '. Waiting for the next session...';
    return;
  }
  var p = crcOk ? Promise.resolve() : Promise.reject(new Error('Checksum mismatch'));
  p.then(function () { return dec.flags & 1 ? Q.decompress(data) : data; }).then(function (out) {
    if (out.length !== meta.s) throw new Error('Size mismatch');
    return Q.sha256hex(out).then(function (h) {
      if (h && meta.h && h !== meta.h) throw new Error('SHA-256 mismatch');
      return { out: out, verified: !!(h && meta.h) };
    });
  }).then(function (r) {
    pushHist(true, t);
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
    result = null; dec = null; meta = null; finishing = false;
  });
}
$('r-share').onclick = function () {
  if (result) navigator.share({ files: [new File([result.blob], result.name, { type: result.blob.type })] }).catch(function () {});
};

if (!window.isSecureContext && location.protocol !== 'file:') $('r-warn').hidden = false;
if (typeof CompressionStream === 'undefined') $('s-warn').hidden = false;
})();
