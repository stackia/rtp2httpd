import type { EPGData, EpgFillChannel } from "./epg-parser";

export interface EPGWorkerRequest {
  url: string;
  validChannelIds?: string[];
  channels?: EpgFillChannel[];
  lookbackHours?: number;
}

export type EPGWorkerResponse = { type: "success"; epg: EPGData } | { type: "error"; message: string };
