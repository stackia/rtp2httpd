/// <reference types="vite/client" />

declare module "*?worker&inline" {
  const workerConstructor: new () => Worker;
  export default workerConstructor;
}

/** User-Agent Client Hints (Chromium); not yet in all DOM lib versions. */
interface NavigatorUAData {
  readonly platform: string;
  readonly mobile: boolean;
}

interface Navigator {
  readonly userAgentData?: NavigatorUAData;
}
