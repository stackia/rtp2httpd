import { createMSEPlaybackBackend } from "../../web-ui/src/playback-engine";
import mp2 from "../../web-ui/src/playback-engine/wasm/minimp3/mp2_decoder.wasm?url";

const video = document.querySelector("video");
if (!video) throw new Error("Missing benchmark video element");
const params = new URLSearchParams(location.search);
const player = createMSEPlaybackBackend(video, {
  wasmDecoders: { mp2 },
  autoDeinterlace: false,
  pictureEnhancement: false,
  logLevel: 4,
  liveSync: true,
});
const events: unknown[] = [];
player.on("error", (e) => events.push({ type: "error", e }));
player.on("media-info", (e) => events.push({ type: "media-info", e }));
player.on("playback-state-change", (e) => events.push({ type: e, time: video.currentTime }));
Object.assign(window, { player, events, video });
player.loadSegments([{ url: params.get("source") ?? "/stream" }]);
void player.play();
