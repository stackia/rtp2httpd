import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import tailwindcss from "@tailwindcss/vite";
import { viteSingleFile } from "vite-plugin-singlefile";

export default defineConfig(() => {
  // Determine which page to build based on environment variable
  const page = process.env.VITE_PAGE || "status";
  const inputFile = page === "player" ? "player.html" : "status.html";

  return {
    plugins: [react(), tailwindcss(), viteSingleFile()],
    build: {
      rollupOptions: {
        input: inputFile,
        output: {
          entryFileNames: `[name].js`,
          assetFileNames: `[name].[ext]`,
        },
      },
      outDir: `dist-${page}`,
    },
    server: {
      proxy: {
        // "/playlist.m3u": "http://router.ccca.cc:5140",
        // "/epg.xml.gz": "http://router.ccca.cc:5140",
        // "^/%E5%A4%AE%E8%A7%86/.*": "http://router.ccca.cc:5140",
        // "^/%E8%B6%85%E9%AB%98%E6%B8%85/.*": "http://router.ccca.cc:5140",
        // "^/%E9%AB%98%E6%B8%85/.*": "http://router.ccca.cc:5140",
      },
    },
  };
});
