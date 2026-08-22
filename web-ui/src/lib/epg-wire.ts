import type { EPGProgram } from "../types/player";
import type { EPGData } from "./epg-parser";

/**
 * Wire protocol between the EPG Web Worker and the main thread.
 *
 * A parsed EPG can hold 100k+ programmes. Posting it as one message makes the
 * main thread deserialize the whole object graph in a single synchronous task,
 * which freezes the page. Instead the worker streams the result as small
 * chunks — each `message` task stays short, so input and rendering can
 * interleave — and the loader reassembles them incrementally.
 *
 * Programmes travel as [startMs, endMs, title] tuples rather than EPGProgram
 * objects: positional arrays avoid per-object property names and Date wrappers
 * in the structured clone, which is the dominant per-programme cost.
 */
export type EPGWireProgram = [startMs: number, endMs: number, title: string | undefined];

/** Catchup-capable channel the worker should gap-fill with fallback programmes. */
export interface EPGCatchupChannel {
  tvgId?: string;
  tvgName?: string;
  name: string;
}

export interface EPGWorkerRequest {
  url: string;
  validChannelIds?: string[];
  catchupChannels?: EPGCatchupChannel[];
}

export interface EPGChunkChannel {
  key: string;
  programs: EPGWireProgram[];
}

export type EPGWorkerMessage =
  | { type: "chunk"; channels: EPGChunkChannel[] }
  | { type: "done"; aliases: [alias: string, primary: string][] }
  | { type: "error"; message: string };

/**
 * Programmes per chunk. Sized so deserializing and rehydrating one chunk takes
 * a few ms even on low-power devices (smart TVs), keeping the page responsive.
 */
export const EPG_CHUNK_SIZE = 2000;

/**
 * Split EPG data into unique programme arrays plus an alias map.
 * EPGData aliases the same array under several keys (tvgId / tvgName / name);
 * sending each array once under its first key keeps the payload minimal, and
 * the aliases restore the remaining keys on the receiving side.
 */
export function splitEPGAliases(epg: EPGData): {
  unique: [key: string, programs: EPGProgram[]][];
  aliases: [alias: string, primary: string][];
} {
  const seen = new Map<EPGProgram[], string>();
  const unique: [string, EPGProgram[]][] = [];
  const aliases: [string, string][] = [];

  for (const key of Object.keys(epg)) {
    const programs = epg[key];
    const primary = seen.get(programs);
    if (primary !== undefined) {
      aliases.push([key, primary]);
    } else {
      seen.set(programs, key);
      unique.push([key, programs]);
    }
  }

  return { unique, aliases };
}

/**
 * Serialize unique programme arrays into chunks of roughly `chunkSize`
 * programmes. A channel's programmes may span consecutive chunks; the receiver
 * appends them in order (postMessage is FIFO).
 */
export function* chunkEPGPrograms(
  unique: [key: string, programs: EPGProgram[]][],
  chunkSize: number = EPG_CHUNK_SIZE,
): Generator<{ channels: EPGChunkChannel[] }, void, void> {
  let channels: EPGChunkChannel[] = [];
  let count = 0;

  for (const [key, programs] of unique) {
    if (programs.length === 0) {
      channels.push({ key, programs: [] });
      continue;
    }

    let offset = 0;
    while (offset < programs.length) {
      const take = Math.min(chunkSize - count, programs.length - offset);
      const wire: EPGWireProgram[] = new Array(take);
      for (let i = 0; i < take; i++) {
        const program = programs[offset + i];
        wire[i] = [program.start.getTime(), program.end.getTime(), program.title];
      }
      channels.push({ key, programs: wire });
      count += take;
      offset += take;

      if (count >= chunkSize) {
        yield { channels };
        channels = [];
        count = 0;
      }
    }
  }

  if (channels.length > 0) {
    yield { channels };
  }
}

export interface EPGReassembler {
  applyChunk(channels: EPGChunkChannel[]): void;
  finish(aliases: [alias: string, primary: string][]): EPGData;
}

/**
 * Incrementally rebuild EPGData from wire chunks. Runs on the main thread, one
 * call per worker message, so the per-chunk work stays small. Programme IDs
 * are recomputed from the channel key and start time, matching the format the
 * parser produces (`${channelId}-${startMs}`).
 */
export function createEPGReassembler(): EPGReassembler {
  const epg: EPGData = {};

  return {
    applyChunk(channels) {
      for (const { key, programs } of channels) {
        let bucket = epg[key];
        if (!bucket) {
          bucket = [];
          epg[key] = bucket;
        }
        for (const [startMs, endMs, title] of programs) {
          bucket.push({
            id: `${key}-${startMs}`,
            title,
            start: new Date(startMs),
            end: new Date(endMs),
          });
        }
      }
    },
    finish(aliases) {
      for (const [alias, primary] of aliases) {
        const programs = epg[primary];
        if (programs) {
          epg[alias] = programs;
        }
      }
      return epg;
    },
  };
}
