import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { fixtureProject } from "./testing.ts";
import { findProjectRoot, resolveWorkflow } from "./workflows.ts";

const workflows = join(fixtureProject, ".aitw", "workflows");

describe("findProjectRoot", () => {
  it("finds the project root from a subdirectory", async () => {
    await expect(findProjectRoot(join(fixtureProject, "src", "nested"))).resolves.toBe(
      fixtureProject,
    );
  });

  it("returns undefined outside a project", async () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "aitw-no-project-")));
    try {
      await expect(findProjectRoot(directory)).resolves.toBeUndefined();
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });
});

describe("resolveWorkflow", () => {
  it("resolves a .yaml file", async () => {
    await expect(resolveWorkflow(fixtureProject, "valid")).resolves.toEqual({
      file: join(workflows, "valid.yaml"),
      ok: true,
      root: fixtureProject,
    });
  });

  it("resolves a .yml file in a subdirectory", async () => {
    await expect(resolveWorkflow(fixtureProject, "release/notes")).resolves.toMatchObject({
      file: join(workflows, "release", "notes.yml"),
    });
  });

  it.each(["../secret", "release/../secret", "/etc/passwd", "release/", "1st", "valid.yaml", ""])(
    "rejects the invalid name %j",
    async (name) => {
      await expect(resolveWorkflow(fixtureProject, name)).resolves.toMatchObject({
        message: expect.stringContaining("Invalid workflow name") as unknown,
        ok: false,
      });
    },
  );

  it("rejects a workflow with both extensions", async () => {
    await expect(resolveWorkflow(fixtureProject, "both")).resolves.toEqual({
      message: "Workflow both has both .yaml and .yml files",
      ok: false,
    });
  });

  it("reports a missing workflow", async () => {
    await expect(resolveWorkflow(fixtureProject, "missing")).resolves.toEqual({
      message: "Workflow not found: missing",
      ok: false,
    });
  });
});
