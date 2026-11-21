# QR Transfer

Send a file from one screen to another device's camera as looping animated QR codes. Single HTML file, no server, no network.

## Use

1. Sender (laptop): open the page (or a saved copy of `index.html`), pick a file, press Start, use Fullscreen.
2. Receiver (phone): open the page over HTTPS (camera access needs a secure context), tab Receive, Start camera, point at the laptop screen from 20-40 cm, held steady.
3. When the bar fills, the file is verified (CRC32, plus SHA-256 when available) and a Download button appears.

Run the "50 KB test file" first and read the KB/s figure, then raise block size / fps until scans get unreliable and back off one step.

## Build

```
npm install
npm test
node build.mjs                                  # dist/index.html (with CSP)
node build.mjs --no-csp --out=index-nocsp.html  # fallback without the CSP tag
```

The GitHub Actions workflow does this on every push to `main` and deploys `dist/` to GitHub Pages. One-time setup: Settings -> Pages -> Source: GitHub Actions.

## Protocol

Frame: magic 0x51, session u16, k u16, blockSize u16, payloadLen u32, flags u8 (bit0 = deflate-raw), frameIndex u32, payload, CRC32.
Frames 0..k-1 are the raw blocks; later frames are XOR combinations chosen by a seeded PRNG (peeling decoder), so missed frames and late joins are fine. Every 10th frame carries metadata (name, type, size, CRC, SHA-256). Raw bytes go straight into QR byte mode; no base64.

## Dependencies

jsQR 1.4.0 (Apache-2.0) and qrcode-generator 2.0.4 by Kazuhiko Arase (MIT), inlined into the built page.

Only use this for files you are permitted to move between devices.
