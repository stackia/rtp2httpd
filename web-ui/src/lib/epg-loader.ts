import type { EPGData } from "./epg-parser";
import EPGWorker from "./epg-worker.ts?worker&inline";

interface EPGWorkerRequest {
  url: string;
  validChannelIds?: string[];
}

type EPGWorkerResponse = { type: "success"; epg: EPGData } | { type: "error"; message: string };

let activeEPGWorker: Worker | null = null;

/**
 * Fetch and parse an XMLTV EPG in a Web Worker so the main thread stays responsive.
 * A newer call terminates any in-flight worker.
 */
export function loadEPG(url: string, validChannelIds?: Set<string>): Promise<EPGData> {
  activeEPGWorker?.terminate();
  const worker = new EPGWorker();
  activeEPGWorker = worker;

  return new Promise((resolve, reject) => {
    const finish = () => {
      if (activeEPGWorker === worker) {
        activeEPGWorker = null;
      }
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
      url,
      validChannelIds: validChannelIds ? Array.from(validChannelIds) : undefined,
    };
    worker.postMessage(request);
  });
}
