export const PlayerErrors = {
  EXCEPTION: "Exception",
  REQUEST_FAILED: "RequestFailed",
  HTTP_STATUS_CODE_INVALID: "HttpStatusCodeInvalid",
  EARLY_EOF: "EarlyEof",
  FORMAT_ERROR: "FormatError",
  FORMAT_UNSUPPORTED: "FormatUnsupported",
  CODEC_UNSUPPORTED: "CodecUnsupported",
  AUDIO_RESYNC_FAILED: "AudioResyncFailed",
  AUDIO_STARTUP_SYNC_FAILED: "AudioStartupSyncFailed",
  MEDIA_SOURCE_CLOSED: "MediaSourceClosed",
  MEDIA_MSE_ERROR: "MediaMSEError",
  MEDIA_ELEMENT_ERROR: "MediaElementError",
} as const;

type ValueOf<T> = T[keyof T];

export type PlayerErrorDetail = ValueOf<typeof PlayerErrors>;

export type LoaderErrorDetail =
  | typeof PlayerErrors.EXCEPTION
  | typeof PlayerErrors.REQUEST_FAILED
  | typeof PlayerErrors.HTTP_STATUS_CODE_INVALID
  | typeof PlayerErrors.EARLY_EOF;

export type DemuxErrorDetail =
  | typeof PlayerErrors.FORMAT_ERROR
  | typeof PlayerErrors.FORMAT_UNSUPPORTED
  | typeof PlayerErrors.CODEC_UNSUPPORTED;
