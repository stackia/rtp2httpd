/// <reference types="vite/client" />

declare const __VERSION__: string;

declare module "*.wasm" {
  export const memory: WebAssembly.Memory;
  export function _initialize(): void;
  export function malloc(size: number): number;
  export function free(ptr: number): void;
  export function mpeg_audio_decoder_create(): number;
  export function mpeg_audio_decoder_destroy(ptr: number): void;
  export function mpeg_audio_decoder_reset(ptr: number): void;
  export function mpeg_audio_decode_payload(
    dec: number,
    inp: number,
    inpSz: number,
    out: number,
    outCap: number,
    info: number,
  ): number;
  export function wsola_create(sampleRate: number, channels: number): number;
  export function wsola_destroy(ptr: number): void;
  export function wsola_reset(ptr: number): void;
  export function wsola_set_ratio(ptr: number, ratio: number): void;
  export function wsola_position(ptr: number): number;
  export function wsola_process(
    ptr: number,
    input: number,
    inFrames: number,
    output: number,
    outCapacity: number,
  ): number;
}
