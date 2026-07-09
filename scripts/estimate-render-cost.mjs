/**
 * Estimate per-frame GPU / bandwidth cost of the WebGL video path.
 *
 * This is an analytical model (not a device measurement) used to compare
 * render modes after the detect-only / texSubImage2D / default-enhancement
 * changes. Numbers assume 1080p RGB8 uploads and a 60 Hz display.
 *
 * Usage: node scripts/estimate-render-cost.mjs
 */

const MODES = [
  {
    name: "baseline (pre-opt): auto-DI + enhancement, progressive",
    uploadsPerSec: 25,
    bwdifPassesPerSec: 0,
    fsrPassesPerSec: 25, // RCAS at least; EASU if upscaling
    detectSamplesPerSec: 2,
    canvasPresent: true,
  },
  {
    name: "baseline (pre-opt): auto-DI + enhancement, interlaced",
    uploadsPerSec: 25,
    bwdifPassesPerSec: 50, // 2 fields × 25 fps
    fsrPassesPerSec: 50,
    detectSamplesPerSec: 2,
    canvasPresent: true,
  },
  {
    name: "after: auto-DI only, progressive (detect-only)",
    uploadsPerSec: 0.5, // sample cadence after progressive confidence
    bwdifPassesPerSec: 0,
    fsrPassesPerSec: 0,
    detectSamplesPerSec: 0.5,
    canvasPresent: false,
  },
  {
    name: "after: auto-DI only, interlaced (bwdif)",
    uploadsPerSec: 25,
    bwdifPassesPerSec: 50,
    fsrPassesPerSec: 0,
    detectSamplesPerSec: 2,
    canvasPresent: true,
  },
  {
    name: "after: auto-DI + enhancement, progressive",
    uploadsPerSec: 25,
    bwdifPassesPerSec: 0,
    fsrPassesPerSec: 25,
    detectSamplesPerSec: 0.5,
    canvasPresent: true,
  },
];

const W = 1920;
const H = 1080;
const BYTES_PER_PIXEL = 3; // RGB upload
const uploadBytesPerFrame = W * H * BYTES_PER_PIXEL;

// Rough relative GPU "work units": fullscreen fragment cost normalized to one
// 1080p passthrough blit. BWDIF is ~8–15× a blit (many texture taps); FSR
// EASU+RCAS is ~6–10×. Detection marker+reduce is cheap at 256-wide.
const UNIT_UPLOAD = 4; // video→texture is bandwidth-heavy on mobile
const UNIT_BLIT = 1;
const UNIT_BWDIF = 12;
const UNIT_FSR = 8;
const UNIT_DETECT = 0.5; // 256-wide marker + reduce chain

console.log("1080p25 analytical GPU cost model (relative work units / second)\n");
console.log(
  `${"mode".padEnd(58)} ${"uploadMB/s".padStart(10)} ${"GPU units/s".padStart(12)} ${"vs worst".padStart(10)}`,
);

const rows = MODES.map((m) => {
  const uploadMBps = (m.uploadsPerSec * uploadBytesPerFrame) / 1e6;
  const units =
    m.uploadsPerSec * UNIT_UPLOAD +
    m.bwdifPassesPerSec * UNIT_BWDIF +
    m.fsrPassesPerSec * UNIT_FSR +
    m.detectSamplesPerSec * UNIT_DETECT +
    (m.canvasPresent ? m.uploadsPerSec * UNIT_BLIT : 0);
  return { ...m, uploadMBps, units };
});

const worst = Math.max(...rows.map((r) => r.units));
for (const r of rows) {
  const pct = ((100 * r.units) / worst).toFixed(0);
  console.log(
    `${r.name.padEnd(58)} ${r.uploadMBps.toFixed(1).padStart(10)} ${r.units.toFixed(0).padStart(12)} ${`${pct}%`.padStart(10)}`,
  );
}

console.log(`
Notes:
- Demux/remux microbench on this host: ~300 MB/s JS throughput.
  At 8 Mbps live that is ~0.3% of one CPU core — not the mobile thermal bottleneck.
- Detect-only progressive path drops texture upload from 25/s to ~0.5/s and
  skips canvas present/FSR entirely → order-of-magnitude GPU relief.
- Interlaced BWDIF remains expensive by design (2 fields/frame); that cost is
  inherent to motion-adaptive deinterlace on RGB browser frames.
`);
