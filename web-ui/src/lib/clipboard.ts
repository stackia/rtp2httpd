/**
 * Copy text to the clipboard.
 *
 * `navigator.clipboard` is only available in a secure context (HTTPS or localhost).
 * rtp2httpd is commonly opened over LAN HTTP, so fall back to execCommand.
 */
export async function copyTextToClipboard(text: string): Promise<void> {
  if (typeof navigator !== "undefined" && window.isSecureContext && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  copyTextWithExecCommand(text);
}

function copyTextWithExecCommand(text: string): void {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.top = "0";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);
  textarea.select();
  textarea.setSelectionRange(0, textarea.value.length);
  const ok = document.execCommand("copy");
  textarea.remove();
  if (!ok) {
    throw new Error("Failed to copy text");
  }
}
