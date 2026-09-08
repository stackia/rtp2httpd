# Video quality lab

Exercises the production WebGL shaders and renderer in a browser, alongside the
previous enhancement implementation and a bilinear reference. No additional
JavaScript dependencies are needed. Recordings and generated PNG/JSON results
stay in the gitignored `build-video-quality/` directory.

## Run

From the repository root:

```sh
source ~/.nvm/nvm.sh
nvm use
node tools/video-quality/prepare-baseline.mjs
node tools/video-quality/prepare-anamorphic.mjs
pnpm exec vite tools/video-quality --config tools/video-quality/vite.config.ts
```

Open `http://127.0.0.1:5186/`. The baseline defaults to commit
`3bf4ca8c5521eebcd8be76c387c3ecbe904d55ac`; pass another compatible revision to
`prepare-baseline.mjs` to select it explicitly. Its source is read with `git show`,
without changing the checkout. The extracted revision is recorded in
`build-video-quality/baseline/revision.json`.

Use the buttons or the developer console:

```js
await qualityLab.synthetic();
await qualityLab.invariants();
await qualityLab.timing(1920, 1080, 1920, 1080);
await qualityLab.timing(1920, 1080, 3840, 2160);
await qualityLab.timing(720, 576, 1920, 1080);
await qualityLab.compare("sport", 3);
await qualityLab.compare("film", 3);
await qualityLab.restoration("sport", 0);
await qualityLab.restoration("sport", 6);
await qualityLab.restoration("film", 0);
await qualityLab.restoration("film", 6);
await qualityLab.lifecycle();
await qualityLab.anamorphic();
```

Run these sequentially, with other video playback paused. Keep the page visible.
Use `?label=safari` (or another label) to keep a browser's results separate.
The lab listens on loopback; its result endpoint only writes into the artifacts
directory. It serves recordings with byte ranges so seeking decodes the requested
frames correctly.

## Recording fixtures

Synthetic, invariant, and GPU timing checks need no recordings. For programme
comparisons, put your own `sport.ts` and `film.ts` captures under
`build-video-quality/fixtures/`. Both should be 1080i, top field first. Prepare
50 fps progressive recordings so all three enhancement modes receive exactly the
same deinterlaced pixels:

```sh
ffmpeg -i build-video-quality/fixtures/sport.ts -an \
  -vf bwdif=mode=send_field:parity=tff:deint=all -c:v libx264 -crf 12 \
  -pix_fmt yuv420p -movflags +faststart build-video-quality/fixtures/sport.mp4
ffmpeg -i build-video-quality/fixtures/film.ts -an \
  -vf bwdif=mode=send_field:parity=tff:deint=all -c:v libx264 -crf 12 \
  -pix_fmt yuv420p -movflags +faststart build-video-quality/fixtures/film.mp4
ffmpeg -i build-video-quality/fixtures/sport.ts -an -c:v copy \
  -movflags +faststart build-video-quality/fixtures/sport-interlaced.mp4
ffmpeg -i build-video-quality/fixtures/film.mp4 -an -t 8 \
  -vf scale=720:576 -c:v libx264 -crf 16 -movflags +faststart \
  build-video-quality/fixtures/sd.mp4
ffmpeg -ss 3 -i build-video-quality/fixtures/sport.mp4 -frames:v 1 \
  build-video-quality/fixtures/sport-reference.png
ffmpeg -ss 3 -i build-video-quality/fixtures/film.mp4 -frames:v 1 \
  build-video-quality/fixtures/film-reference.png
```

The SD fixture is derived from HD. Its 16:9 sample aspect ratio means the browser
reports a display width of 1024, although the encoded raster is 720 × 576.
Do not commit recordings, private playlists, or programme images.

`prepare-anamorphic.mjs` uses FFmpeg to generate small, static color-pattern
fixtures without broadcast recordings: PAL 4:3 (720 × 576, SAR 16:15), PAL 16:9
(720 × 576, SAR 64:45), and NTSC 4:3 (720 × 480, SAR 8:9). Asymmetric colored
borders expose padding, cropping, and orientation errors across the whole frame.
Browsers may apply SAR by expanding width or height; neither display dimension
can be assumed to match the decoded raster.

## What the checks measure

- **Synthetic:** clean gradients, thin detail, static grain, moving edges, and
  moving edges with grain. Noise uses deterministic independent seeds for 16
  frames, approximately 6 code values of luma standard deviation plus chroma
  noise. PSNR/MAE compare RGB with known clean pixels, excluding alpha. Exact
  equality is represented as PSNR 100. Flat colors check transfer-curve drift.
- **Invariants:** odd dimensions, history orientation, scene cuts, slow
  low-contrast movement, and isoluminant movement. Both float history and a
  forced RGBA8 fallback execute on real WebGL objects. The motion checks compare
  the entire image, including vacated areas and corners, with known pixels.
- **Restoration:** exact CPU 2 × 2 area reduction of a known 1080p frame to 540p,
  followed by reconstruction to 1080p. The noisy variant adds independent grain
  to 16 observations of that reference. This tests reconstruction fidelity; it
  does not establish a noise-free reference for the original broadcast.
- **Recorded comparisons:** independently seeks twelve successive 50 fps frames,
  checks each decoded media timestamp within 1 ms, and feeds them in order to
  each mode. Saved PNGs use the same last frame and output size. Inspect faces,
  subtitles, dark textures, and motion boundaries at 1:1 pixel scale.
- **Timing:** asynchronous `EXT_disjoint_timer_query_webgl2` queries around
  denoising and presentation. Each sample averages eight draws; 45 samples per
  mode are collected across three rounds with rotating mode order and twelve
  warm-up draws. Reported p95 is the p95 of these batch averages. Upload, decode,
  deinterlacing, and browser composition are excluded. Without the extension,
  results are labeled CPU+GPU completion time, not GPU time. Disjoint samples
  are discarded and insufficient samples fail the run.
- **Lifecycle:** the actual video render pipeline processes an interlaced
  recording, checks two presentations per source frame, repeated paused toggles,
  seeking, source/resolution changes, raw-video fallback, context restoration,
  GL errors, and resource release. It uses the production context attributes.
- **Anamorphic:** compares the complete rendered frame with a native
  `drawImage(video)` reference at the same output size. Covers enabling processing
  after raw playback is paused, repeated paused toggles, source/resolution
  changes, deinterlacing with and without enhancement, and continuous field
  playback. Requires mean RGB error below two code values and fewer than 0.5%
  of samples differing by more than twenty; shader edge filtering is tolerated,
  but a padded or cropped frame fails. Drawing-buffer capture happens inside
  presentation, before the browser discards it.

## Reference measurements

Recorded on 2026-09-08 with an Apple M3 Max (40 GPU cores), Chromium 152 and ANGLE
Metal. Full numerical results and source/fixture hashes are in
[`measurements.json`](./measurements.json). These are measurements on one device;
Safari/WebKit and physical iPad performance have not been verified.

PSNR in dB (higher is better):

| Case | Bilinear/raw | Previous enhancement | Current enhancement |
| --- | ---: | ---: | ---: |
| Clean synthetic detail | Exact | 38.06 | 46.94 |
| Static synthetic grain | 32.20 | 28.48 | 34.52 |
| Moving detail with grain | 32.20 | 28.40 | 34.35 |
| Sport reference, 540p → 1080p | 34.81 | 34.33 | 36.85 |
| Film reference, 540p → 1080p | 33.51 | 33.51 | 35.19 |
| Noisy sport reference, 540p → 1080p | 32.48 | 30.37 | 33.66 |
| Noisy film reference, 540p → 1080p | 31.78 | 30.74 | 32.85 |

Flat colors had zero code-value error in the current enhancement, versus a
maximum of six in the previous implementation. Clean denoiser-only output had
a maximum error of one. The low-contrast and isoluminant motion invariants had
zero error in both history formats.

Enhancement GPU milliseconds per draw, measured as described above:

| Source → output | Previous median | Current median | Previous p95 | Current p95 |
| --- | ---: | ---: | ---: | ---: |
| 1920 × 1080 → 1920 × 1080 | 0.516 | 0.720 | 1.086 | 0.962 |
| 1920 × 1080 → 3840 × 2160 | 1.925 | 2.066 | 3.454 | 4.104 |
| 720 × 576 → 1920 × 1080 | 1.062 | 1.161 | 1.360 | 2.074 |

Full MSE playback through a separate NAS preview was also checked: a 15-second
1080i broadcast interval decoded 375 frames with zero dropped/corrupted frames
and zero GL errors, both at native output and at 3840 × 2160. The renderer
lifecycle test presented 50 fields for 25 source callbacks and retained no
textures, framebuffers, programs, or shaders after destruction.

## Implementation boundaries

The denoiser uses one source-resolution pass with nine current-frame samples and
five history samples. RGB stores the filtered image; alpha stores original luma
for motion/noise analysis. Two RGBA16F history textures cost 31.6 MiB at 1080p;
RGBA8 fallback halves that. EASU's RGB10_A2 intermediate costs 31.6 MiB at 4K,
the same storage as RGBA8. These figures exclude upload/deinterlacing targets and
the browser's canvas buffers.

FSR presentation expects the denoiser's original-luma alpha. Its intermediate
alpha carries quantized noise information for luma-only sharpening. The source
gate remains 1920 × 1088, with output capped at 3840 × 2160 and the device's
texture limit. History resets on seeks, source/stage changes, and discontinuous
timestamps. No future frames or motion-compensated frame interpolation are added;
interlaced playback retains the existing two-field presentation.

The RGB video upload ring uses immutable storage before its first
`texSubImage2D(video)` call. This avoids reusing decoder-backed storage imported
by `texImage2D(video)`, which can reject subsequent frame updates on ANGLE Metal.
Texture and filter dimensions come from `requestVideoFrameCallback` media pixels;
`videoWidth`/`videoHeight` describe presentation and may include SAR scaling.
The renderer learns one frame's metadata even with processing disabled, so a
paused toggle can use the correct raster without adding an idle render loop.

For a static preview alongside a running daemon, proxy its application-prefix
routes to that daemon as well as serving the new `web-ui/dist` assets. The M3U
parser converts absolute programme/EPG URLs to site-root-relative paths.
