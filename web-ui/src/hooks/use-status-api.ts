import { useCallback } from "react";
import { buildStatusPath, buildUrl } from "../lib/url";

export function useStatusApi() {
  const disconnectClient = useCallback(async (clientId: string) => {
    const response = await fetch(buildUrl(buildStatusPath("/api/disconnect")), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: clientId }).toString(),
    });
    const data = await response.json().catch(() => undefined);
    if (!response.ok) {
      throw new Error(data?.error ?? `Request failed with status ${response.status}`);
    }
  }, []);

  const setLogLevel = useCallback(async (level: string) => {
    const response = await fetch(buildUrl(buildStatusPath("/api/log-level")), {
      method: "PUT",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ level }).toString(),
    });
    if (!response.ok) {
      throw new Error(`Request failed with status ${response.status}`);
    }
  }, []);

  return {
    disconnectClient,
    setLogLevel,
  };
}
