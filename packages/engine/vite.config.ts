import { mergeConfig } from "vite";

import { libraryConfig } from "../../vite.lib.ts";

export default mergeConfig(libraryConfig, {
  build: {
    lib: {
      // Workers bundle the workflow code from its own file.
      entry: { index: "src/index.ts", workflows: "src/workflows/index.ts" },
      fileName: (_format: string, name: string) => `${name}.js`,
    },
  },
});
