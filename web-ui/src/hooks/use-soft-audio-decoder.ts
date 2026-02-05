/*
 * useSoftAudioDecoder Hook
 *
 * React hook for managing software audio decoding in the video player
 */

import { useCallback, useEffect, useRef, useState } from "react";
import mpegts from "@rtp2httpd/mpegts.js";
import {
  checkSoftDecodeRequirements,
  createSoftAudioDecoderManager,
  logCodecSupport,
} from "../lib/soft-audio-decoder-loader";

export interface SoftAudioDecoderState {
  isActive: boolean;
  codec: string | null;
  error: string | null;
}

export interface UseSoftAudioDecoderOptions {
  videoElement: HTMLVideoElement | null;
  enabled?: boolean;
  onError?: (error: string) => void;
}

export function useSoftAudioDecoder({
  videoElement,
  enabled = true,
  onError,
}: UseSoftAudioDecoderOptions) {
  const managerRef = useRef<InstanceType<typeof mpegts.SoftAudioDecoderManager> | null>(null);
  const [state, setState] = useState<SoftAudioDecoderState>({
    isActive: false,
    codec: null,
    error: null,
  });

  // Log codec support on mount
  useEffect(() => {
    logCodecSupport();
  }, []);

  // Initialize manager
  useEffect(() => {
    if (!enabled) {
      return;
    }

    const requirements = checkSoftDecodeRequirements();
    const needsSoftDecode =
      requirements.mp2NeedsSwDecode || requirements.ac3NeedsSwDecode;

    if (!needsSoftDecode) {
      console.log("All audio codecs are natively supported, soft decode not needed");
      return;
    }

    console.log("Initializing SoftAudioDecoderManager");
    managerRef.current = createSoftAudioDecoderManager();

    return () => {
      if (managerRef.current) {
        managerRef.current.destroy();
        managerRef.current = null;
      }
    };
  }, [enabled]);

  // Attach/detach video element
  useEffect(() => {
    if (!managerRef.current || !videoElement) {
      return;
    }

    managerRef.current.attachVideo(videoElement);

    return () => {
      if (managerRef.current) {
        managerRef.current.detachVideo();
      }
    };
  }, [videoElement]);

  /**
   * Initialize decoder for a specific codec
   */
  const initDecoder = useCallback(
    async (codec: "mp2" | "ac-3") => {
      if (!managerRef.current) {
        return false;
      }

      try {
        const success = await managerRef.current.initDecoder(codec);
        if (success) {
          setState({
            isActive: true,
            codec,
            error: null,
          });
        }
        return success;
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : "Unknown error";
        setState({
          isActive: false,
          codec: null,
          error: errorMsg,
        });
        onError?.(errorMsg);
        return false;
      }
    },
    [onError],
  );

  /**
   * Decode audio data
   */
  const decode = useCallback((data: Uint8Array, pts: number): boolean => {
    if (!managerRef.current) {
      return false;
    }
    return managerRef.current.decode(data, pts);
  }, []);

  /**
   * Start/resume audio playback
   */
  const play = useCallback(async () => {
    if (managerRef.current) {
      await managerRef.current.play();
    }
  }, []);

  /**
   * Pause audio playback
   */
  const pause = useCallback(() => {
    if (managerRef.current) {
      managerRef.current.pause();
    }
  }, []);

  /**
   * Stop playback and clear buffers
   */
  const stop = useCallback(() => {
    if (managerRef.current) {
      managerRef.current.stop();
    }
    setState({
      isActive: false,
      codec: null,
      error: null,
    });
  }, []);

  /**
   * Flush decoder state (call on seek)
   */
  const flush = useCallback(() => {
    if (managerRef.current) {
      managerRef.current.flush();
    }
  }, []);

  /**
   * Set volume
   */
  const setVolume = useCallback((volume: number) => {
    if (managerRef.current) {
      managerRef.current.setVolume(volume);
    }
  }, []);

  /**
   * Set muted state
   */
  const setMuted = useCallback((muted: boolean) => {
    if (managerRef.current) {
      managerRef.current.setMuted(muted);
    }
  }, []);

  return {
    state,
    initDecoder,
    decode,
    play,
    pause,
    stop,
    flush,
    setVolume,
    setMuted,
    isManager: () => managerRef.current !== null,
  };
}
