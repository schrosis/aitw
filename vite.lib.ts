import { isAbsolute } from "node:path";
import { defineConfig } from "vite";

/** Shared Vite library configuration for every workspace package. */
export const libraryConfig = defineConfig({
  build: {
    emptyOutDir: false,
    lib: {
      entry: "src/index.ts",
      fileName: "index",
      formats: ["es"],
    },
    minify: false,
    rollupOptions: {
      external: (id) => !id.startsWith(".") && !isAbsolute(id),
    },
    sourcemap: true,
    target: "node26",
  },
});
