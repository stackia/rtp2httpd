import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const fixtures = resolve(import.meta.dirname, "../../build-video-quality/fixtures");
mkdirSync(fixtures, { recursive: true });

for (const [name, height, sar] of [
  ["4x3", 576, "16/15"],
  ["16x9", 576, "64/45"],
  ["ntsc", 480, "8/9"],
]) {
  // Asymmetric, nonblack borders reveal padding, cropping and orientation errors.
  const pattern = [
    `color=c=0x406080:s=720x${height}:r=25`,
    `drawbox=x=0:y=0:w=96:h=${height}:color=0xc04030:t=fill`,
    `drawbox=x=624:y=0:w=96:h=${height}:color=0x30a050:t=fill`,
    "drawbox=x=300:y=180:w=120:h=128:color=white:t=fill",
    `setsar=${sar}`,
  ].join(",");
  const result = spawnSync(
    "ffmpeg",
    [
      "-nostdin",
      "-y",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      pattern,
      "-t",
      "4",
      "-c:v",
      "libx264",
      "-crf",
      "12",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      resolve(fixtures, `anamorphic-${name}.mp4`),
    ],
    { stdio: "inherit" },
  );
  if (result.status !== 0) throw result.error ?? new Error(`Failed to generate ${name} fixture`);
}
