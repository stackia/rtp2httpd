import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const root = fileURLToPath(new URL("../../", import.meta.url));
if (!process.argv[2]) throw new Error("Usage: node tools/player-benchmark/build.mjs <output-directory>");
const demux = process.argv[3] === "demux";
await build({
  root,
  configFile: false,
  base: "./",
  build: {
    ssr: demux,
    outDir: resolve(process.argv[2]),
    emptyOutDir: true,
    sourcemap: true,
    rolldownOptions: {
      input: resolve(root, demux ? "tools/player-benchmark/demux-benchmark.ts" : "tools/player-benchmark/index.html"),
    },
  },
});
