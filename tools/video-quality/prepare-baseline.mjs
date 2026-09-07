import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const repo = resolve(import.meta.dirname, "../..");
const ref = process.argv[2] ?? "3bf4ca8c5521eebcd8be76c387c3ecbe904d55ac";
const revision = execFileSync("git", ["rev-parse", "--verify", `${ref}^{commit}`], {
  cwd: repo,
  encoding: "utf8",
}).trim();
const output = resolve(repo, "build-video-quality/baseline");
await mkdir(resolve(output, "filters"), { recursive: true });
for (const path of ["fsr.ts", "presenters.ts", "filters/gl-utils.ts", "filters/types.ts", "filters/mosquito-nr.ts"]) {
  let source = execFileSync("git", ["show", `${revision}:web-ui/src/playback-engine/render/${path}`], {
    cwd: repo,
    encoding: "utf8",
  });
  // Expose the original class to the lab without registering a competing filter.
  if (path.endsWith("mosquito-nr.ts"))
    source = source.replace("class MosquitoNrFilter", "export class MosquitoNrFilter");
  await writeFile(resolve(output, path), source);
}
await writeFile(resolve(output, "revision.json"), JSON.stringify({ revision }, null, 2));
console.log(`Prepared video enhancement baseline ${revision}`);
