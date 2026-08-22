import { fillChannelEPGGaps, parseEPG } from "./epg-parser";
import { chunkEPGPrograms, type EPGWorkerMessage, type EPGWorkerRequest, splitEPGAliases } from "./epg-wire";

function post(message: EPGWorkerMessage): void {
  (self as unknown as { postMessage(msg: unknown): void }).postMessage(message);
}

self.addEventListener("message", async (event: MessageEvent<EPGWorkerRequest>) => {
  const { url, validChannelIds, catchupChannels } = event.data;
  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch EPG: ${response.statusText}`);
    }
    const xmlText = await response.text();
    const epg = parseEPG(xmlText, validChannelIds ? new Set(validChannelIds) : undefined);

    // Gap-fill here so the main thread never pays for it when the result lands.
    if (catchupChannels?.length) {
      for (const channel of catchupChannels) {
        fillChannelEPGGaps(epg, channel);
      }
    }

    // Stream the result in chunks: one giant message would deserialize in a
    // single synchronous main-thread task and freeze the page.
    const { unique, aliases } = splitEPGAliases(epg);
    for (const chunk of chunkEPGPrograms(unique)) {
      post({ type: "chunk", channels: chunk.channels });
    }
    post({ type: "done", aliases });
  } catch (error) {
    post({
      type: "error",
      message: error instanceof Error ? error.message : "Failed to load EPG",
    });
  }
});
