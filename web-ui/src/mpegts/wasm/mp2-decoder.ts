import {
  _initialize,
  free,
  malloc,
  memory,
  mpeg_audio_decode_payload,
  mpeg_audio_decoder_create,
  mpeg_audio_decoder_destroy,
  mpeg_audio_decoder_reset,
  wsola_create,
  wsola_destroy,
  wsola_position,
  wsola_process,
  wsola_reset,
  wsola_set_ratio,
} from "./minimp3/mp2_decoder.wasm";

export interface Mp2DecoderWasmExports {
  memory: WebAssembly.Memory;
  malloc: (size: number) => number;
  free: (ptr: number) => void;
  mpeg_audio_decoder_create: () => number;
  mpeg_audio_decoder_destroy: (ptr: number) => void;
  mpeg_audio_decoder_reset: (ptr: number) => void;
  mpeg_audio_decode_payload: (
    dec: number,
    inp: number,
    inpSz: number,
    out: number,
    outCap: number,
    info: number,
  ) => number;
  wsola_create: (sampleRate: number, channels: number) => number;
  wsola_destroy: (ptr: number) => void;
  wsola_reset: (ptr: number) => void;
  wsola_set_ratio: (ptr: number, ratio: number) => void;
  wsola_position: (ptr: number) => number;
  wsola_process: (ptr: number, input: number, inFrames: number, output: number, outCapacity: number) => number;
}

let initialized = false;

export function getMp2DecoderWasmExports(): Mp2DecoderWasmExports {
  if (!initialized) {
    _initialize();
    initialized = true;
  }

  return {
    memory,
    malloc,
    free,
    mpeg_audio_decoder_create,
    mpeg_audio_decoder_destroy,
    mpeg_audio_decoder_reset,
    mpeg_audio_decode_payload,
    wsola_create,
    wsola_destroy,
    wsola_reset,
    wsola_set_ratio,
    wsola_position,
    wsola_process,
  };
}
