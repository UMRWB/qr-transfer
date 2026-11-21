# QR Transfer

Send a file from one screen to another device's camera as looping animated QR codes. Single HTML file, no server, no network.

## Use

1. Sender (laptop): open the page (or a saved copy of `index.html`), pick a file, press Start, use Fullscreen.
2. Receiver (phone): open the page over HTTPS (camera access needs a secure context), tab Receive, Start camera, point at the laptop screen from 20-40 cm, held steady.
3. When the bar fills, the file is verified (CRC32, plus SHA-256 when available) and a Download button appears.

## Lanes (dual-lane mode)

Set Lanes to 2 on the sender, go Fullscreen in landscape. Two codes sit side by side and are updated in turns, so one is always still while the other changes; this reduces frames torn by the camera's rolling shutter. Display changes are locked to whole screen refreshes (the page measures your refresh rate and shows e.g. `hold 4 refresh @ 60 Hz = 15 codes/s`). The receiver finds the second code in the same camera frame automatically. "Codes/s per lane" is the target per lane; the page rounds to whole refreshes.

## Benchmark

Sender readout: nominal KB/s (what the screen is asked to show), shown KB/s (what it actually drew) and `late` (refreshes where the next code was not ready; non-zero means the laptop cannot render that fast, so lower the settings).

Receiver readout (updates every 0.5 s, 5 s window): camera fps, scans/s, decoded/s, valid/s, CRC-bad/s, new blocks/s, goodput KB/s, and scan time p50/p95 in ms. Goodput is the number that decides transfer time.

Sweep: on the sender press Benchmark sweep (sends the 50 KB test file through 400/800/1400/2000 B single-lane and 800/1400 B dual-lane, 30 s each). On the phone tick Benchmark mode and start the camera; each step is added to a results table (complete, or partial with blocks received, time, KB/s). Pick the fastest row that completes reliably.

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
Frames 0..k-1 are the raw blocks; later frames are XOR combinations chosen by a seeded PRNG (peeling decoder), so missed frames and late joins are fine. Every 10th frame carries metadata (name, type, size, CRC, SHA-256, lanes). Raw bytes go straight into QR byte mode; no base64.

## Dependencies

jsQR 1.4.0 (Apache-2.0) and qrcode-generator 2.0.4 by Kazuhiko Arase (MIT), inlined into the built page.

Only use this for files you are permitted to move between devices.
