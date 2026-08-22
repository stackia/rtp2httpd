import { fillEPGGaps, parseEPG } from "./epg-parser";
import type { EPGWorkerRequest, EPGWorkerResponse } from "./epg-worker-protocol";

function post(message: EPGWorkerResponse): void {
  (self as unknown as { postMessage(msg: unknown): void }).postMessage(message);
}

self.addEventListener("message", async (event: MessageEvent<EPGWorkerRequest>) => {
  const { url, validChannelIds, channels, lookbackHours } = event.data;
  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch EPG: ${response.statusText}`);
    }
    const xmlText = await response.text();
    const epg = parseEPG(xmlText, validChannelIds ? new Set(validChannelIds) : undefined);
    post({ type: "success", epg: channels ? fillEPGGaps(epg, channels, lookbackHours) : epg });
  } catch (error) {
    post({
      type: "error",
      message: error instanceof Error ? error.message : "Failed to load EPG",
    });
  }
});
