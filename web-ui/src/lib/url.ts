type RuntimeConfig = {
  appPathPrefix?: string;
};

declare global {
  interface Window {
    __RTP2HTTPD_CONFIG__?: RuntimeConfig;
  }
}

export function getAppPathPrefix(): string {
  if (typeof window === "undefined") return "";
  return window.__RTP2HTTPD_CONFIG__?.appPathPrefix ?? "";
}

export function buildAppPath(path: string): string {
  const prefix = getAppPathPrefix();
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${prefix}${normalizedPath}`;
}

export function getStatusBasePath(): string {
  const currentPath = window.location.pathname.replace(/\/+$/, "");
  return currentPath === "" ? "/" : currentPath;
}

export function buildStatusPath(suffix: string): string {
  const basePath = getStatusBasePath();
  if (!suffix) {
    return basePath;
  }

  const normalizedSuffix = suffix.startsWith("/") ? suffix : `/${suffix}`;
  if (basePath === "/") {
    return normalizedSuffix;
  }

  return `${basePath}${normalizedSuffix}`;
}

/**
 * Strip scheme/host from playlist URLs, leaving site-root-relative paths.
 * Matches server use-relative-path-in-m3u output (e.g. /app/rtp2httpd/Channel).
 * Query-only templates (e.g. ?playseek=...) are returned unchanged.
 */
export function toPlaylistRelativePath(url: string): string {
  if (!url) {
    return url;
  }

  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    return url;
  }

  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return url;
  }
}
