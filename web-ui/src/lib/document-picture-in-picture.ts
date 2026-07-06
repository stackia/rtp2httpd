type DocumentPictureInPictureOptions = {
  preferInitialWindowPlacement?: boolean;
  width?: number;
  height?: number;
};

type DocumentPictureInPictureController = {
  readonly window: Window | null;
  requestWindow: (options?: DocumentPictureInPictureOptions) => Promise<Window>;
};

type WindowWithDocumentPictureInPicture = Window & {
  readonly documentPictureInPicture?: DocumentPictureInPictureController;
};

const DOCUMENT_PIP_ASPECT_RATIO = 16 / 9;
const DOCUMENT_PIP_MIN_WIDTH = 320;
const DOCUMENT_PIP_MAX_WIDTH = 640;
const DOCUMENT_PIP_FALLBACK_WIDTH = 480;

export function getDocumentPictureInPicture(): DocumentPictureInPictureController | null {
  const documentPictureInPicture = (window as WindowWithDocumentPictureInPicture).documentPictureInPicture;
  return documentPictureInPicture?.requestWindow ? documentPictureInPicture : null;
}

export function isPictureInPictureSupported(): boolean {
  return getDocumentPictureInPicture() !== null || Boolean(document.pictureInPictureEnabled);
}

/**
 * Document Picture-in-Picture (`requestWindow`) is only permitted from a top-level
 * browsing context. When the player runs inside an iframe the call rejects with a
 * `NotAllowedError` DOMException ("Opening a PiP window is only allowed from a
 * top-level browsing context"). Detect that so callers can fall back to the
 * traditional video Picture-in-Picture API.
 */
export function isDocumentPictureInPictureBlockedError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "NotAllowedError";
}

export function isAnyPictureInPictureActive(): boolean {
  return !!(document.pictureInPictureElement || getDocumentPictureInPicture()?.window);
}

type DocumentPiPWindowSize = {
  width: number;
  height: number;
};

type DocumentPiPWindowOptions = DocumentPiPWindowSize & {
  preferInitialWindowPlacement: true;
};

export function getDocumentPiPWindowOptions(playerElement: HTMLElement): DocumentPiPWindowOptions {
  const rect = playerElement.getBoundingClientRect();
  const sourceWidth = rect.width > 0 ? rect.width : DOCUMENT_PIP_FALLBACK_WIDTH;
  const width = Math.round(Math.min(Math.max(sourceWidth, DOCUMENT_PIP_MIN_WIDTH), DOCUMENT_PIP_MAX_WIDTH));

  return {
    preferInitialWindowPlacement: true,
    width,
    height: Math.round(width / DOCUMENT_PIP_ASPECT_RATIO),
  };
}

function copyStyleSheetsToWindow(targetWindow: Window): void {
  const targetDocument = targetWindow.document;

  for (const styleSheet of Array.from(document.styleSheets)) {
    try {
      const cssRules = Array.from(styleSheet.cssRules, (rule) => rule.cssText).join("\n");
      const style = targetDocument.createElement("style");
      style.textContent = cssRules;
      targetDocument.head.appendChild(style);
    } catch {
      if (!styleSheet.href) continue;

      const link = targetDocument.createElement("link");
      link.rel = "stylesheet";
      link.href = styleSheet.href;
      link.media = styleSheet.media.mediaText;
      targetDocument.head.appendChild(link);
    }
  }
}

export function setupDocumentPiPWindow(targetWindow: Window): void {
  const targetDocument = targetWindow.document;
  targetDocument.title = document.title;
  targetDocument.documentElement.className = document.documentElement.className;
  targetDocument.documentElement.style.colorScheme = document.documentElement.style.colorScheme;
  targetDocument.documentElement.style.width = "100%";
  targetDocument.documentElement.style.height = "100%";
  targetDocument.body.className = "overflow-hidden overscroll-none bg-black text-foreground antialiased";
  targetDocument.body.style.margin = "0";
  targetDocument.body.style.width = "100%";
  targetDocument.body.style.height = "100%";
  targetDocument.body.style.overflow = "hidden";
  targetDocument.body.style.background = "#000";

  copyStyleSheetsToWindow(targetWindow);
}
