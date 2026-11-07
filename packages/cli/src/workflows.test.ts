import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createTestProject } from "./testing.ts";
import type { TestProject } from "./testing.ts";
import { findProjectRoot, resolveWorkflow } from "./workflows.ts";

describe("resolveWorkflow", () => {
  let project: TestProject;

  beforeEach(() => {
    project = createTestProject();
  });

  afterEach(() => {
    project.remove();
  });

  it("finds the project root from a subdirectory", async () => {
    const subdirectory = join(project.root, "src", "nested");
    mkdirSync(subdirectory, { recursive: true });

    await expect(findProjectRoot(subdirectory)).resolves.toBe(project.root);
  });

  it("resolves .yaml and .yml files", async () => {
    const yaml = project.write(".aitw/workflows/deploy.yaml", "");
    const yml = project.write(".aitw/workflows/build.yml", "");

    await expect(resolveWorkflow(project.root, "deploy")).resolves.toEqual({
      file: yaml,
      ok: true,
      root: project.root,
    });
    await expect(resolveWorkflow(project.root, "build")).resolves.toMatchObject({ file: yml });
  });

  it("resolves a workflow in a subdirectory", async () => {
    const file = project.write(".aitw/workflows/release/notes.yaml", "");

    await expect(resolveWorkflow(project.root, "release/notes")).resolves.toMatchObject({ file });
  });

  it.each(["../secret", "release/../secret", "/etc/passwd", "release/", "1st", "foo.yaml", ""])(
    "rejects the invalid name %j",
    async (name) => {
      await expect(resolveWorkflow(project.root, name)).resolves.toMatchObject({
        message: expect.stringContaining("Invalid workflow name") as unknown,
        ok: false,
      });
    },
  );

  it("rejects a workflow with both extensions", async () => {
    project.write(".aitw/workflows/deploy.yaml", "");
    project.write(".aitw/workflows/deploy.yml", "");

    await expect(resolveWorkflow(project.root, "deploy")).resolves.toEqual({
      message: "Workflow deploy has both .yaml and .yml files",
      ok: false,
    });
  });

  it("reports a missing workflow", async () => {
    await expect(resolveWorkflow(project.root, "missing")).resolves.toEqual({
      message: "Workflow not found: missing",
      ok: false,
    });
  });
});
