/// <reference types="vite/client" />

/** User-Agent Client Hints (Chromium); not yet in all DOM lib versions. */
interface NavigatorUAData {
  readonly platform: string;
  readonly mobile: boolean;
}

interface Navigator {
  readonly userAgentData?: NavigatorUAData;
}
