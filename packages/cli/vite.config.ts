import { mergeConfig } from "vite";

import { libraryConfig } from "../../vite.lib.ts";

export default mergeConfig(libraryConfig, {
  build: {
    lib: {
      entry: { bin: "src/bin.ts", index: "src/index.ts" },
      fileName: (_format: string, name: string) => `${name}.js`,
    },
  },
});
