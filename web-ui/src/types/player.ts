export interface Channel {
  id: string;
  name: string;
  logo?: string;
  group: string;
  url: string;
  tvgId?: string;
  tvgName?: string;
  catchup?: string;
  catchupSource?: string;
}

export interface EPGProgram {
  id: string;
  title?: string;
  start: Date;
  end: Date;
}

export interface M3UMetadata {
  tvgUrl?: string;
  channels: Channel[];
  groups: string[];
}

export type PlayMode = "live" | "catchup";

export interface PlayerState {
  currentChannel: Channel | null;
  playMode: PlayMode;
  currentTime: Date;
  isPlaying: boolean;
  volume: number;
  isMuted: boolean;
}
