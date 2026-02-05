/*
 * Soft Audio Decoder Loader
 *
 * Utility to load WASM audio decoders on demand for rtp2httpd web-ui
 */

import mpegts from "@rtp2httpd/mpegts.js";

// WASM module paths (relative to public directory)
const MP2_DECODER_PATH = "/wasm/mp2_decoder.js";
const AC3_DECODER_PATH = "/wasm/ac3_decoder.js";

/**
 * Check if software audio decoding is needed
 */
export function checkSoftDecodeRequirements(): {
  mp2NeedsSwDecode: boolean;
  ac3NeedsSwDecode: boolean;
  eac3NeedsSwDecode: boolean;
} {
  return {
    mp2NeedsSwDecode: mpegts.needsSoftwareDecode("mp2"),
    ac3NeedsSwDecode: mpegts.needsSoftwareDecode("ac-3"),
    eac3NeedsSwDecode: mpegts.needsSoftwareDecode("ec-3"),
  };
}

/**
 * Create MP2 decoder WASM module loader
 */
export async function loadMp2DecoderModule(): Promise<any> {
  // Dynamic import of the WASM module
  const moduleFactory = await import(/* @vite-ignore */ MP2_DECODER_PATH);
  return moduleFactory.default();
}

/**
 * Create AC3 decoder WASM module loader
 */
export async function loadAc3DecoderModule(): Promise<any> {
  // Dynamic import of the WASM module
  const moduleFactory = await import(/* @vite-ignore */ AC3_DECODER_PATH);
  return moduleFactory.default();
}

/**
 * Create a SoftAudioDecoderManager with lazy-loaded WASM modules
 */
export function createSoftAudioDecoderManager(): InstanceType<
  typeof mpegts.SoftAudioDecoderManager
> {
  return new mpegts.SoftAudioDecoderManager({
    mp2ModuleLoader: loadMp2DecoderModule,
    ac3ModuleLoader: loadAc3DecoderModule,
    playerConfig: {
      bufferDuration: 0.1,
      maxDrift: 0.05,
      enableSync: true,
    },
  });
}

/**
 * Log codec support status to console
 */
export function logCodecSupport(): void {
  const support = mpegts.getCodecSupport();
  console.log("Browser Audio Codec Support:");
  console.log(`  MP2: ${support.get("mp2") ? "Native" : "Needs Software Decode"}`);
  console.log(`  AC-3: ${support.get("ac-3") ? "Native" : "Needs Software Decode"}`);
  console.log(`  E-AC3: ${support.get("ec-3") ? "Native" : "Needs Software Decode"}`);
}
