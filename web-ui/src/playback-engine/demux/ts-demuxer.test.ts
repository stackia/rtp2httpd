import { describe, expect, it, vi } from "vitest";
import TSDemuxer from "./ts-demuxer";

function section(pid: number, bytes: number[]): Uint8Array {
  const packet = new Uint8Array(188).fill(0xff);
  packet.set([0x47, 0x40 | (pid >> 8), pid & 255, 0x10, 0, ...bytes]);
  return packet;
}
function pcrPacket(base: number, discontinuity = false): Uint8Array {
  const packet = new Uint8Array(188).fill(0xff);
  packet.set([0x47, 1, 1, 0x20, 183, discontinuity ? 0x90 : 0x10]);
  packet.set(
    [
      Math.floor(base / 2 ** 25),
      Math.floor(base / 2 ** 17) & 255,
      Math.floor(base / 2 ** 9) & 255,
      Math.floor(base / 2) & 255,
      ((base % 2) << 7) | 0x7e,
      0,
    ],
    6,
  );
  return packet;
}
function transport(packets: Uint8Array[], stride: number): Uint8Array {
  const output = new Uint8Array(packets.length * stride);
  packets.forEach((packet, i) => {
    output.set(packet, i * stride + (stride === 192 ? 4 : 0));
  });
  return output;
}

describe("TS packet offsets", () => {
  it.each([188, 192, 204])("reads PCR and discontinuity flags with %i-byte packets", (stride) => {
    // A single-program PAT/PMT declares PID 257 as the PCR/video PID.
    const pat = section(0, [0, 0xb0, 13, 0, 1, 0xc1, 0, 0, 0, 1, 0xe1, 0, 0, 0, 0, 0]);
    const pmt = section(256, [2, 0xb0, 18, 0, 1, 0xc1, 0, 0, 0xe1, 1, 0xf0, 0, 0x1b, 0xe1, 1, 0xf0, 0, 0, 0, 0, 0]);
    const packets = [pat, pmt, pcrPacket(2 ** 33 - 90000), pcrPacket(0, true), pcrPacket(90000)];
    const bytes = transport(packets, stride);
    const demux = new TSDemuxer({ match: true, ts_packet_size: stride, sync_offset: 0 });
    demux.onError = vi.fn();
    demux.onTrackMetadata = vi.fn();
    demux.onDataAvailable = vi.fn();
    const pcr = vi.fn();
    demux.onPcr = pcr;
    // The second call starts at a nonzero byteOffset in the same allocation.
    expect(demux.parseChunks(bytes.subarray(0, stride * 3), 1000)).toBe(stride * 3);
    expect(demux.parseChunks(bytes.subarray(stride * 3), 1000 + stride * 3)).toBe(stride * 2);
    expect(pcr.mock.calls).toEqual([
      [2 ** 33 - 90000, 1000 + stride * 2, false],
      [2 ** 33, 1000 + stride * 3, true],
      [2 ** 33 + 90000, 1000 + stride * 4, false],
    ]);
    expect(demux.onError).not.toHaveBeenCalled();
  });
});
