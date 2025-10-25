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
  };
});
