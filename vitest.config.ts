import { tmpdir } from "node:os";
import { join } from "node:path";

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Tests keep logs and other state in a directory of their own, not in the state of the user.
    env: { XDG_STATE_HOME: join(tmpdir(), `aitw-vitest-state-${process.pid}`) },
    globalSetup: ["./vitest.global-setup.ts"],
    include: ["packages/*/src/**/*.test.ts"],
  },
});
