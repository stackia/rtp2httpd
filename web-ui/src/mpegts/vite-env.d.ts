/// <reference types="vite/client" />

declare const __VERSION__: string;

declare module "*?worker&inline" {
  const workerConstructor: new () => Worker;
  export default workerConstructor;
}
