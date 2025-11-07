import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "path";

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss()],
    build: {
      rollupOptions: {
        input: {
          status: resolve(__dirname, "status.html"),
          player: resolve(__dirname, "player.html"),
        },
      },
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
