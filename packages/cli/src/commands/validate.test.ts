import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createTestProject } from "../testing.ts";
import type { TestProject } from "../testing.ts";
import { validate } from "./validate.ts";

const validSource = `version: v0.1
start: fetch
steps:
  fetch:
    type: script
    run: ./fetch.sh
    next: end
`;

describe("validate", () => {
  let project: TestProject;
  let stdout: string;
  let stderr: string;

  beforeEach(() => {
    project = createTestProject();
    stdout = "";
    stderr = "";
  });

  afterEach(() => {
    project.remove();
  });

  const run = async (name: string) =>
    validate(name, {
      cwd: project.root,
      stderr: (text) => {
        stderr += text;
      },
      stdout: (text) => {
        stdout += text;
      },
    });

  it("reports a valid definition", async () => {
    project.write(".aitw/workflows/deploy.yaml", validSource);

    await expect(run("deploy")).resolves.toBe(0);
    expect(stdout).toBe("deploy: valid\n");
    expect(stderr).toBe("");
  });

  it("skips transition checks when the schema is invalid", async () => {
    project.write(
      ".aitw/workflows/deploy.yaml",
      validSource.replace("next: end", "next: report").replace("v0.1", "v9"),
    );

    await expect(run("deploy")).resolves.toBe(1);
    expect(stderr).toBe(
      `.aitw/workflows/deploy.yaml:1:10 version: Invalid input: expected "v0.1"\n`,
    );
  });

  it("reports a transition error with its location", async () => {
    project.write(".aitw/workflows/deploy.yaml", validSource.replace("next: end", "next: report"));

    await expect(run("deploy")).resolves.toBe(1);
    expect(stderr).toBe(
      ".aitw/workflows/deploy.yaml:7:11 steps.fetch.next: Unknown step: report\n",
    );
  });

  it("reports a workflow that cannot be resolved", async () => {
    await expect(run("missing")).resolves.toBe(1);
    expect(stderr).toBe("Workflow not found: missing\n");
  });
});
