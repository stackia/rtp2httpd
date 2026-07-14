import assert from "node:assert/strict";
import test from "node:test";
import {
  audioRenditionPreferenceKey,
  mediaTimeBoundaryIndex,
  parseM3U8,
  programDateTimeBoundaryIndex,
  selectAudioRendition,
} from "./m3u8.ts";

test("parses and resolves alternate audio renditions for the selected variant group", () => {
  const playlist = parseM3U8(
    `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="English",DEFAULT=YES,AUTOSELECT=YES,LANGUAGE="en",URI="audio/en.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="中文",DEFAULT=NO,AUTOSELECT=YES,LANGUAGE="zh",URI="/audio/zh.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="unused",NAME="Other",URI="other.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=15000000,RESOLUTION=3840x2160,FRAME-RATE=50.000,AUDIO="audio"
video/index.m3u8
`,
    "https://example.test/live/master.m3u8",
  );

  assert.equal(playlist.kind, "multivariant");
  if (playlist.kind !== "multivariant") return;
  assert.equal(playlist.variants[0].audioGroupId, "audio");
  assert.equal(playlist.variants[0].url, "https://example.test/live/video/index.m3u8");
  assert.deepEqual(
    playlist.audioRenditions.map((track) => [track.name, track.url, track.isDefault, track.autoselect]),
    [
      ["English", "https://example.test/live/audio/en.m3u8", true, true],
      ["中文", "https://example.test/audio/zh.m3u8", false, true],
      ["Other", "https://example.test/live/other.m3u8", false, false],
    ],
  );
});

test("builds a stable audio preference key without using the rendition URL", () => {
  assert.equal(audioRenditionPreferenceKey(" Audio ", " English ", " EN "), "audio\u001fenglish\u001fen");
});

test("selects preferred, default, autoselect, then first audio rendition", () => {
  const playlist = parseM3U8(
    `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="First",URI="first.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Auto",AUTOSELECT=YES,URI="auto.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Default",DEFAULT=YES,URI="default.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=1,AUDIO="audio"
video.m3u8
`,
    "https://example.test/master.m3u8",
  );
  assert.equal(playlist.kind, "multivariant");
  if (playlist.kind !== "multivariant") return;
  const tracks = playlist.audioRenditions;
  assert.equal(selectAudioRendition(tracks)?.name, "Default");
  assert.equal(selectAudioRendition(tracks, tracks[1].preferenceKey)?.name, "Auto");
  assert.equal(selectAudioRendition(tracks.map((track) => ({ ...track, isDefault: false })))?.name, "Auto");
  assert.equal(
    selectAudioRendition(tracks.map((track) => ({ ...track, isDefault: false, autoselect: false })))?.name,
    "First",
  );
});

test("propagates EXT-X-PROGRAM-DATE-TIME across media segments", () => {
  const playlist = parseM3U8(
    `#EXTM3U
#EXT-X-TARGETDURATION:8
#EXT-X-PROGRAM-DATE-TIME:2026-07-14T10:00:00.000Z
#EXTINF:8.0,
one.ts
#EXTINF:8.0,
two.ts
#EXT-X-ENDLIST
`,
    "https://example.test/live/index.m3u8",
  );

  assert.equal(playlist.kind, "media");
  if (playlist.kind !== "media") return;
  assert.equal(playlist.segments[0].programDateTime, Date.parse("2026-07-14T10:00:00.000Z"));
  assert.equal(playlist.segments[1].programDateTime, Date.parse("2026-07-14T10:00:08.000Z"));
});

test("aligns rendition switches to media and absolute-time segment boundaries", () => {
  const segments = [
    { url: "one", duration: 6, start: 0, mediaSequence: 100, discontinuity: false, programDateTime: 10_000 },
    { url: "two", duration: 6, start: 6, mediaSequence: 101, discontinuity: false, programDateTime: 16_000 },
    { url: "three", duration: 6, start: 12, mediaSequence: 102, discontinuity: false, programDateTime: 22_000 },
  ];
  assert.equal(mediaTimeBoundaryIndex(segments, 4), 1);
  assert.equal(mediaTimeBoundaryIndex(segments, 30), 2);
  assert.equal(programDateTimeBoundaryIndex(segments, 17_000), 2);
  assert.equal(programDateTimeBoundaryIndex(segments, 30_000), 2);
});
