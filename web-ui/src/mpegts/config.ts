/** Player configuration options. All fields are optional when passed to `createPlayer()`. */
export interface PlayerConfig {
  /** Chase live stream latency by changing playbackRate. @default true */
  liveSync: boolean;
  /** Maximum acceptable buffer latency in seconds. Requires `liveSync: true`. @default 1.2 */
  liveSyncMaxLatency: number;
  /** Target latency in seconds to chase when latency exceeds `liveSyncMaxLatency`. Requires `liveSync: true`. @default 0.8 */
  liveSyncTargetLatency: number;
  /** PlaybackRate (clamped to [1, 2]) used for latency chasing. Requires `liveSync: true`. @default 1.2 */
  liveSyncPlaybackRate: number;

  /** URLs to WASM decoder files, keyed by codec. Omit to disable software decoding for that codec.
   *  e.g. `{ mp2: "/assets/mp2_decoder.wasm" }` */
  wasmDecoders: { mp2?: string };

  /** Max backward buffer duration in seconds. Cleanup triggers when buffer exceeds this. @default 180 */
  bufferCleanupMaxBackward: number;
  /** Min backward buffer to retain after cleanup in seconds. @default 120 */
  bufferCleanupMinBackward: number;

  /** Referrer policy for HTTP requests. Applied to each segment's `referrerPolicy` field. */
  referrerPolicy: string | undefined;
  /** Additional headers to add to HTTP requests. */
  headers: Record<string, string> | undefined;
  /** Frontend log level: 0=FATAL, 1=ERROR, 2=WARN, 3=INFO, 4=DEBUG/VERBOSE. */
  logLevel: number | undefined;

  /** Overlay canvas the player draws WebGL-rendered frames onto. Omit to disable WebGL video rendering.
   *  The player never touches the canvas' style/visibility — drive that from the
   *  `render-state-change` event. */
  renderCanvas: HTMLCanvasElement | undefined;
  /** Automatic bwdif deinterlacing enabled for detected interlaced content. @default true */
  autoDeinterlace: boolean;
  /** Lightweight WebGL picture enhancement enabled inside the render gate. @default true */
  pictureEnhancement: boolean;
}

export const defaultConfig: PlayerConfig = {
  liveSync: true,
  liveSyncMaxLatency: 3,
  liveSyncTargetLatency: 1.5,
  liveSyncPlaybackRate: 1.2,

  wasmDecoders: {},

  bufferCleanupMaxBackward: 180,
  bufferCleanupMinBackward: 120,

  referrerPolicy: undefined,
  headers: undefined,
  logLevel: undefined,

  renderCanvas: undefined,
  autoDeinterlace: true,
  pictureEnhancement: true,
};

export function createDefaultConfig(): PlayerConfig {
  return { ...defaultConfig };
}
