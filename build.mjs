import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const args = process.argv.slice(2);
const noCsp = args.includes('--no-csp');
const outArg = args.find((a) => a.startsWith('--out='));
const outName = outArg ? outArg.slice(6) : 'index.html';
const here = (p) => new URL(p, import.meta.url);
const rd = (p) => readFileSync(here(p), 'utf8');
const esc = (s) => s.replace(/<\/script/gi, '<\\/script');

function lib(pkg, file, marker) {
  const candidates = [];
  try { candidates.push(require.resolve(pkg)); } catch (e) {}
  candidates.push(here('./node_modules/' + pkg + '/dist/' + file).pathname, here('./vendor/' + file).pathname);
  for (const p of candidates) {
    if (existsSync(p)) {
      const s = readFileSync(p, 'utf8');
      if (!s.includes(marker)) throw new Error(p + ' does not look like ' + pkg);
      return s;
    }
  }
  throw new Error('Cannot find ' + pkg + ' - run npm install');
}

let html = rd('./src/index.template.html');
const csp = "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src blob: mediastream:\">";
const own = rd('./src/core.js') + '\n' + rd('./src/app.js');
for (const bad of ['fetch(', 'XMLHttpRequest', 'WebSocket', 'sendBeacon', 'importScripts', 'import(', 'eval(']) {
  if (own.includes(bad)) throw new Error('Forbidden API in app code: ' + bad);
}
if (/https?:\/\//.test(own)) throw new Error('URL found in app code');

const parts = {
  '<!--CSP-->': noCsp ? '' : csp,
  '/*VENDOR_QRGEN*/': esc(lib('qrcode-generator', 'qrcode.js', 'QR Code Generator for JavaScript')),
  '/*VENDOR_JSQR*/': esc(lib('jsqr', 'jsQR.js', 'jsQR')),
  '/*CORE*/': esc(rd('./src/core.js')),
  '/*APP*/': esc(rd('./src/app.js')),
};
for (const [k, v] of Object.entries(parts)) {
  if (!html.includes(k)) throw new Error('missing placeholder ' + k);
  html = html.replace(k, () => v);
}
mkdirSync(here('./dist/'), { recursive: true });
writeFileSync(here('./dist/' + outName), html);
console.log('dist/' + outName, (html.length / 1024).toFixed(1) + ' KB', noCsp ? '(no CSP)' : '(CSP on)');
