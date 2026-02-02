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
