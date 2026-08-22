import type { EPGData, EpgFillChannel } from "./epg-parser";
import EPGWorker from "./epg-worker.ts?worker&inline";
import type { EPGWorkerRequest, EPGWorkerResponse } from "./epg-worker-protocol";

interface LoadEPGOptions {
  validChannelIds?: Set<string>;
  channels?: EpgFillChannel[];
  lookbackHours?: number;
}

let inFlight: { key: string; promise: Promise<EPGData> } | null = null;

function requestKey(url: string, options: LoadEPGOptions | undefined): string {
  return `${url}\0${options?.lookbackHours ?? ""}\0${options?.validChannelIds?.size ?? 0}\0${options?.channels?.length ?? 0}`;
}

/**
 * Fetch, parse, and gap-fill an XMLTV EPG in a Web Worker so the main thread
 * only applies the finished object. Overlapping calls with the same arguments
 * share the in-flight job (React StrictMode remount).
 */
export function loadEPG(url: string, options?: LoadEPGOptions): Promise<EPGData> {
  const key = requestKey(url, options);
  if (inFlight?.key === key) {
    return inFlight.promise;
  }

  const worker = new EPGWorker();
  const promise = new Promise<EPGData>((resolve, reject) => {
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
      validChannelIds: options?.validChannelIds ? Array.from(options.validChannelIds) : undefined,
      channels: options?.channels,
      lookbackHours: options?.lookbackHours,
    };
    worker.postMessage(request);
  });

  inFlight = { key, promise };
  void promise.finally(() => {
    if (inFlight?.promise === promise) {
      inFlight = null;
    }
  });

  return promise;
}
