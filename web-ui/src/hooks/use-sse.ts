import { useCallback, useEffect, useRef } from "react";
import type { StatusPayload } from "../types";
import type { ConnectionState } from "../types/ui";
import { buildStatusPath, buildUrl } from "../lib/url";

export function useSse(
  onPayload: (payload: StatusPayload) => void,
  onConnectionChange: (state: ConnectionState) => void,
) {
  const reconnectRef = useRef<number>(-1);
  const sourceRef = useRef<EventSource | null>(null);

  const connect = useCallback(() => {
    if (sourceRef.current) {
      sourceRef.current.close();
      sourceRef.current = null;
    }

    const ssePath = buildStatusPath("/sse");

    const source = new EventSource(buildUrl(ssePath));
    sourceRef.current = source;

    source.onopen = () => {
      window.clearTimeout(reconnectRef.current);
      reconnectRef.current = -1;
      onConnectionChange("connected");
    };

    source.onerror = () => {
      onConnectionChange("disconnected");
      source.close();
      window.clearTimeout(reconnectRef.current);
      reconnectRef.current = -1;
      reconnectRef.current = window.setTimeout(() => {
        onConnectionChange("reconnecting");
        connect();
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
  }, [onConnectionChange, onPayload]);

  useEffect(() => {
    connect();
    return () => {
      if (sourceRef.current) {
        sourceRef.current.close();
        sourceRef.current = null;
      }
      window.clearTimeout(reconnectRef.current);
      reconnectRef.current = -1;
    };
  }, [connect]);
}
