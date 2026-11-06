import { describe, expect, it } from "vitest";

import { workspacePackages } from "./index.ts";

describe("workspacePackages", () => {
  it("resolves every workspace dependency", () => {
    expect(workspacePackages).toEqual([
      "@aitw/core",
      "@aitw/definition",
      "@aitw/engine",
      "@aitw/adapter-script-local",
    ]);
  });
});
