export type RuntimeConfig = {
  appPathPrefix?: string;
  logLevel?: number;
};

function getRuntimeConfig(): RuntimeConfig {
  if (typeof globalThis === "undefined") {
    return {};
  }
  return (globalThis as { __RTP2HTTPD_CONFIG__?: RuntimeConfig }).__RTP2HTTPD_CONFIG__ ?? {};
}

export function getAppPathPrefix(): string {
  return getRuntimeConfig().appPathPrefix ?? "";
}

export function getRuntimeLogLevel(): number | undefined {
  const value = getRuntimeConfig().logLevel;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
