import { type EPGChannelDescriptor, type EPGData, fillEPGGaps, parseEPG } from "./epg-parser";

interface EPGWorkerRequest {
  /** XMLTV URL; omitted when the playlist has no x-tvg-url, in which case only gap-fill runs. */
  url?: string;
  channels: EPGChannelDescriptor[];
}

type EPGWorkerResponse = { type: "success"; epg: EPGData; fetchError?: string } | { type: "error"; message: string };

function post(message: EPGWorkerResponse): void {
  (self as unknown as { postMessage(msg: unknown): void }).postMessage(message);
}

self.addEventListener("message", async (event: MessageEvent<EPGWorkerRequest>) => {
  const { url, channels } = event.data;
  try {
    let epg: EPGData = {};
    let fetchError: string | undefined;

    if (url) {
      try {
        const response = await fetch(url);
        if (!response.ok) {
          throw new Error(`Failed to fetch EPG: ${response.statusText}`);
        }
        const xmlText = await response.text();
        const validChannelIds = new Set<string>();
        for (const channel of channels) {
          if (channel.tvgId) validChannelIds.add(channel.tvgId);
          if (channel.tvgName) validChannelIds.add(channel.tvgName);
          validChannelIds.add(channel.name);
        }
        epg = parseEPG(xmlText, validChannelIds);
      } catch (error) {
        // Still deliver gap-filled fallback programs so catchup channels stay seekable.
        fetchError = error instanceof Error ? error.message : "Failed to load EPG";
      }
    }

    // Gap filling runs exactly once, here, so the main thread receives final data.
    post({ type: "success", epg: fillEPGGaps(epg, channels), fetchError });
  } catch (error) {
    post({
      type: "error",
      message: error instanceof Error ? error.message : "Failed to load EPG",
    });
  }
});
