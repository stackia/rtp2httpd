import { useCallback, useEffect, useRef, useState } from "react";
import type { StatusPayload } from "../types";
import type { ConnectionState } from "../types/ui";
import { buildStatusPath } from "../lib/url";

export function useSse(
  onPayload: (payload: StatusPayload) => void,
  onConnectionChange: (state: ConnectionState) => void,
) {
  const reconnectRef = useRef<number>(0);
  const sourceRef = useRef<EventSource | null>(null);
  const [retryCount, setRetryCount] = useState(0);

  const connect = useCallback(() => {
    if (sourceRef.current) {
      sourceRef.current.close();
      sourceRef.current = null;
    }

    const ssePath = buildStatusPath("/sse");

    const source = new EventSource(ssePath);
    sourceRef.current = source;

    source.onopen = () => {
      window.clearTimeout(reconnectRef.current);
      reconnectRef.current = 0;
      onConnectionChange("connected");
    };

    source.onerror = () => {
      onConnectionChange("disconnected");
      source.close();
      window.clearTimeout(reconnectRef.current);
      reconnectRef.current = window.setTimeout(() => {
        onConnectionChange("reconnecting");
        setRetryCount(retryCount + 1);
      }, 1000);
    };

    source.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data) as StatusPayload;
        onPayload(payload);
      } catch (error) {
        console.error("Failed to parse SSE payload", error);
      }
    };
  }, [onConnectionChange, onPayload, retryCount]);

  useEffect(() => {
    connect();
    return () => {
      if (sourceRef.current) {
        sourceRef.current.close();
        sourceRef.current = null;
      }
      window.clearTimeout(reconnectRef.current);
      reconnectRef.current = 0;
    };
  }, [connect]);
}
