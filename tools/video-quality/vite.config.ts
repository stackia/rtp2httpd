import { createReadStream } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { defineConfig } from "vite";

const repo = resolve(import.meta.dirname, "../..");
const artifacts = resolve(repo, "build-video-quality");

export default defineConfig({
  define: { __QUALITY_BASELINE__: JSON.stringify(`/@fs/${artifacts}/baseline`) },
  server: { host: "127.0.0.1", port: 5186, strictPort: true, fs: { allow: [repo] } },
  plugins: [
    {
      name: "quality-artifacts",
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          const match = req.url?.match(/^\/(fixtures|results)\/([\w.-]+)$/);
          if (!match) return next();
          const [, directory, name] = match;
          const path = resolve(artifacts, directory, name);
          if (req.method === "POST" && directory === "results") {
            const chunks: Buffer[] = [];
            let size = 0;
            for await (const chunk of req) {
              size += chunk.length;
              if (size > 80 * 1024 * 1024) {
                res.writeHead(413).end();
                return;
              }
              chunks.push(chunk);
            }
            await mkdir(resolve(artifacts, directory), { recursive: true });
            await writeFile(path, Buffer.concat(chunks));
            res.writeHead(201).end();
          } else if (req.method === "GET" || req.method === "HEAD") {
            const info = await stat(path).catch(() => null);
            if (!info?.isFile()) return res.writeHead(404).end();
            const range = req.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
            const start = range ? Number(range[1]) : 0;
            const end = range?.[2] ? Math.min(Number(range[2]), info.size - 1) : info.size - 1;
            if (start > end || start >= info.size) return res.writeHead(416).end();
            res.setHeader("Accept-Ranges", "bytes");
            res.setHeader("Content-Length", end - start + 1);
            if (range) {
              res.statusCode = 206;
              res.setHeader("Content-Range", `bytes ${start}-${end}/${info.size}`);
            }
            if (name.endsWith(".mp4")) res.setHeader("Content-Type", "video/mp4");
            if (name.endsWith(".png")) res.setHeader("Content-Type", "image/png");
            if (req.method === "HEAD") return res.end();
            const stream = createReadStream(path, { start, end });
            res.on("close", () => stream.destroy());
            stream.on("error", () => res.destroy());
            stream.pipe(res);
          } else res.writeHead(405).end();
        });
      },
    },
  ],
});
