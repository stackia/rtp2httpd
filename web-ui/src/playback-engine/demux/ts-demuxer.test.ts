import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";

function psiPacket(pid: number, section: number[]): Uint8Array {
  const packet = new Uint8Array(188).fill(0xff);
  packet.set([0x47, 0x40 | ((pid >>> 8) & 0x1f), pid & 0xff, 0x10, 0x00, ...section]);
  return packet;
}

function nullPacket(): Uint8Array {
  const packet = new Uint8Array(188).fill(0xff);
  packet.set([0x47, 0x1f, 0xff, 0x10]);
  return packet;
}

function iso639(language: string): number[] {
  return [0x0a, 0x04, ...Array.from(language, (value) => value.charCodeAt(0)), 0x00];
}

function audioStream(streamType: number, pid: number, language: string): number[] {
  const descriptors = iso639(language);
  return [streamType, 0xe0 | ((pid >>> 8) & 0x1f), pid & 0xff, 0xf0, descriptors.length, ...descriptors];
}

function multiAudioTransportStream(): Uint8Array {
  const pat = [0x00, 0xb0, 0x0d, 0x00, 0x01, 0xc1, 0x00, 0x00, 0x00, 0x01, 0xf0, 0x00, 0x00, 0x00, 0x00, 0x00];
  const streams = [
    0x1b,
    0xe1,
    0x00,
    0xf0,
    0x00,
    ...audioStream(0x0f, 0x101, "eng"),
    ...audioStream(0x03, 0x102, "zho"),
    ...audioStream(0x81, 0x103, "spa"),
  ];
  const sectionLength = 9 + streams.length + 4;
  const pmt = [
    0x02,
    0xb0 | ((sectionLength >>> 8) & 0x0f),
    sectionLength & 0xff,
    0x00,
    0x01,
    0xc1,
    0x00,
    0x00,
    0xe1,
    0x00,
    0xf0,
    0x00,
    ...streams,
    0x00,
    0x00,
    0x00,
    0x00,
  ];
  const packets = [psiPacket(0, pat), psiPacket(0x1000, pmt), nullPacket(), nullPacket()];
  const data = new Uint8Array(packets.length * 188);
  packets.forEach((packet, index) => {
    data.set(packet, index * 188);
  });
  return data;
}

test("discovers and selects AAC, MP2, and AC-3 PIDs without rebuilding video", async () => {
  Object.assign(globalThis, { self: globalThis });
  const server = await createServer({ logLevel: "silent", server: { middlewareMode: true }, appType: "custom" });
  try {
    const { default: TSDemuxer } = await server.ssrLoadModule("/web-ui/src/playback-engine/demux/ts-demuxer.ts");
    const data = multiAudioTransportStream();
    const probe = TSDemuxer.probe(data);
    const demuxer = new TSDemuxer(probe);
    const states: Array<{ tracks: unknown[]; selectedPid: number | undefined }> = [];
    demuxer.onError = (type: string, info: string) => assert.fail(`${type}: ${info}`);
    demuxer.onTrackMetadata = () => {};
    demuxer.onDataAvailable = () => {};
    demuxer.onAudioTracks = (tracks: unknown[], selectedPid: number | undefined) => {
      states.push({ tracks, selectedPid });
    };

    demuxer.parseChunks(data, 0);
    assert.deepEqual(states.at(-1), {
      tracks: [
        { pid: 0x101, codec: "aac", language: "eng" },
        { pid: 0x102, codec: "mpeg", language: "zho" },
        { pid: 0x103, codec: "ac3", language: "spa" },
      ],
      selectedPid: 0x101,
    });
    assert.equal(demuxer.hasVideo, true);
    assert.equal(demuxer.selectAudioPid(0x102), true);
    assert.equal(states.at(-1)?.selectedPid, 0x102);
    assert.equal(demuxer.hasVideo, true);
    assert.equal(demuxer.selectAudioPid(0x103), true);
    assert.equal(states.at(-1)?.selectedPid, 0x103);
    assert.equal(demuxer.selectAudioPid(0x999), false);
  } finally {
    await server.close();
  }
});
