# Playback Engine

This directory contains the media playback engine used by the web player. Its public entry point is `index.ts`; UI code should not import private MSE pipeline modules directly.

## Module boundaries

- `backends/`: public MSE and Native backend implementations behind the shared `PlaybackBackend` contract.
- `mse/`: private MSE playback controller, MediaSource integration, and live-sync policy.
- `timeline/`: wall-clock mapping shared by the engine and player UI.
- `worker/`: transmux worker protocol, source scheduling, and pipeline orchestration.
- `demux/`, `remux/`, `hls/`, and `io/`: transport and container processing used by the MSE backend.
- `audio/` and `decoder/`: software-decoded audio playback and decoder adapters.
- `render/`: WebGL deinterlacing and video enhancement used by the MSE backend.
- `wasm/`: bundled native sources and WebAssembly artifacts.

Dependencies should flow from `backends/` into the implementation modules. Private implementation modules must not import UI components, and code outside the engine should use `index.ts` unless it needs a documented timeline helper.
