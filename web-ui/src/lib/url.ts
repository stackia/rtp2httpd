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
