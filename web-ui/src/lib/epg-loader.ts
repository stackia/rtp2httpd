import type { EPGData } from "./epg-parser";
import EPGWorker from "./epg-worker.ts?worker&inline";

interface EPGWorkerRequest {
  url: string;
  validChannelIds?: string[];
}

type EPGWorkerResponse = { type: "success"; epg: EPGData } | { type: "error"; message: string };

let inFlight: Promise<EPGData> | null = null;

/**
 * Fetch and parse an XMLTV EPG in a Web Worker so the main thread stays responsive.
 * The player loads EPG once; overlapping calls share the same in-flight job
 * (React StrictMode remount) instead of starting a second parse.
 */
export function loadEPG(url: string, validChannelIds?: Set<string>): Promise<EPGData> {
  if (inFlight) {
    return inFlight;
  }

  const worker = new EPGWorker();
  inFlight = new Promise((resolve, reject) => {
    const finish = () => {
      worker.terminate();
    };

    worker.onmessage = (event: MessageEvent<EPGWorkerResponse>) => {
      finish();
      if (event.data.type === "success") {
        resolve(event.data.epg);
        return;
      }
      reject(new Error(event.data.message));
    };

    worker.onerror = (event) => {
      finish();
      reject(new Error(event.message || "Failed to load EPG"));
    };

    const request: EPGWorkerRequest = {
      // Inline blob workers resolve relative URLs against `blob:`, so make this absolute first.
      url: new URL(url, document.baseURI).href,
      validChannelIds: validChannelIds ? Array.from(validChannelIds) : undefined,
    };
    worker.postMessage(request);
  });

  void inFlight.finally(() => {
    inFlight = null;
  });

  return inFlight;
}
