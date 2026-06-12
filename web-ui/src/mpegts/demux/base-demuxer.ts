import type MediaInfo from "../core/media-info";
import type { KLVData } from "./klv";
import type { PESPrivateData, PESPrivateDataDescriptor } from "./pes-private-data";
import type { PGSData } from "./pgs-data";
import type { SCTE35Data } from "./scte35";
import type { SMPTE2038Data } from "./smpte2038";

type OnErrorCallback = (type: string, info: string) => void;
type OnMediaInfoCallback = (mediaInfo: MediaInfo) => void;
type OnTrackMetadataCallback = (type: string, metadata: unknown) => void;
type OnDataAvailableCallback = (audioTrack: unknown, videoTrack: unknown) => void;
type OnTimedID3MetadataCallback = (timed_id3_data: PESPrivateData) => void;
type onPGSSubitleDataCallback = (pgs_data: PGSData) => void;
type OnSynchronousKLVMetadataCallback = (synchronous_klv_data: KLVData) => void;
type OnAsynchronousKLVMetadataCallback = (asynchronous_klv_data: PESPrivateData) => void;
type OnSMPTE2038MetadataCallback = (smpte2038_data: SMPTE2038Data) => void;
type OnSCTE35MetadataCallback = (scte35_data: SCTE35Data) => void;
type OnPESPrivateDataCallback = (private_data: PESPrivateData) => void;
type OnPESPrivateDataDescriptorCallback = (private_data_descriptor: PESPrivateDataDescriptor) => void;

export default abstract class BaseDemuxer {
  public onError: OnErrorCallback | null = null;
  public onMediaInfo: OnMediaInfoCallback | null = null;
  public onTrackMetadata: OnTrackMetadataCallback | null = null;
  public onDataAvailable: OnDataAvailableCallback | null = null;
  public onTimedID3Metadata: OnTimedID3MetadataCallback | null = null;
  public onPGSSubtitleData: onPGSSubitleDataCallback | null = null;
  public onSynchronousKLVMetadata: OnSynchronousKLVMetadataCallback | null = null;
  public onAsynchronousKLVMetadata: OnAsynchronousKLVMetadataCallback | null = null;
  public onSMPTE2038Metadata: OnSMPTE2038MetadataCallback | null = null;
  public onSCTE35Metadata: OnSCTE35MetadataCallback | null = null;
  public onPESPrivateData: OnPESPrivateDataCallback | null = null;
  public onPESPrivateDataDescriptor: OnPESPrivateDataDescriptorCallback | null = null;

  public destroy(): void {
    this.onError = null;
    this.onMediaInfo = null;
    this.onTrackMetadata = null;
    this.onDataAvailable = null;
    this.onTimedID3Metadata = null;
    this.onPGSSubtitleData = null;
    this.onSynchronousKLVMetadata = null;
    this.onAsynchronousKLVMetadata = null;
    this.onSMPTE2038Metadata = null;
    this.onSCTE35Metadata = null;
    this.onPESPrivateData = null;
    this.onPESPrivateDataDescriptor = null;
  }

  abstract parseChunks(chunk: ArrayBuffer, byteStart: number): number;
}
