import type { EPGData } from "./epg-parser";
import { createEPGReassembler, type EPGCatchupChannel, type EPGWorkerMessage, type EPGWorkerRequest } from "./epg-wire";
import EPGWorker from "./epg-worker.ts?worker&inline";

let inFlight: Promise<EPGData> | null = null;

/**
 * Fetch and parse an XMLTV EPG in a Web Worker so the main thread stays responsive.
 * The worker streams the parsed result back in small chunks (see epg-wire.ts);
 * reassembling one chunk per message task avoids the single long
 * deserialization freeze a monolithic postMessage would cause.
 * The player loads EPG once; overlapping calls share the same in-flight job
 * (React StrictMode remount) instead of starting a second parse.
 */
export function loadEPG(
  url: string,
  validChannelIds?: Set<string>,
  catchupChannels?: EPGCatchupChannel[],
): Promise<EPGData> {
  if (inFlight) {
    return inFlight;
  }

  const worker = new EPGWorker();
  inFlight = new Promise((resolve, reject) => {
    const reassembler = createEPGReassembler();
    const finish = () => {
      worker.terminate();
    };

    worker.onmessage = (event: MessageEvent<EPGWorkerMessage>) => {
      try {
        const message = event.data;
        if (message.type === "chunk") {
          reassembler.applyChunk(message.channels);
          return;
        }
        finish();
        if (message.type === "done") {
          resolve(reassembler.finish(message.aliases));
          return;
        }
        reject(new Error(message.message));
      } catch (error) {
        finish();
        reject(error);
      }
    };

    worker.onerror = (event) => {
      finish();
      reject(new Error(event.message || "Failed to load EPG"));
    };

    const request: EPGWorkerRequest = {
      // Inline blob workers resolve relative URLs against `blob:`, so make this absolute first.
      url: new URL(url, document.baseURI).href,
      validChannelIds: validChannelIds ? Array.from(validChannelIds) : undefined,
      catchupChannels,
    };
    worker.postMessage(request);
  });

  void inFlight.finally(() => {
    inFlight = null;
  });

  return inFlight;
}
