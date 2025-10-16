export function buildUrl(path: string): string {
  const url = new URL(window.location.href);
  const params = new URLSearchParams(url.search);
  const token = params.get("r2h-token");
  if (token) {
    const separator = path.includes("?") ? "&" : "?";
    return `${path}${separator}r2h-token=${encodeURIComponent(token)}`;
  }
  return path;
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
