/// <reference types="vite/client" />

/** User-Agent Client Hints (Chromium); not yet in all DOM lib versions. */
interface NavigatorUAData {
  readonly platform: string;
}

interface Navigator {
  readonly userAgentData?: NavigatorUAData;
}
