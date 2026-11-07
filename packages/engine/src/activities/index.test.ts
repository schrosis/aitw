import { ScriptTimeoutError } from "@aitw/core";
import type { ScriptRunner } from "@aitw/core";
import { MockActivityEnvironment } from "@temporalio/testing";
import { describe, expect, it } from "vitest";

import { createActivities } from "./index.ts";

const execute = async (scriptRunner: ScriptRunner) =>
  new MockActivityEnvironment().run(createActivities({ scriptRunner }).executeScriptStep, {
    input: {},
    run: "./run.sh",
    timeoutMs: 1000,
  });

describe("executeScriptStep", () => {
  it("succeeds when the script exits with zero", async () => {
    await expect(
      execute({ run: async () => ({ exitCode: 0, signal: null, stderr: "", stdout: "secret" }) }),
    ).resolves.toBeUndefined();
  });

  it("fails without retrying when the script exits with an error", async () => {
    await expect(
      execute({ run: async () => ({ exitCode: 2, signal: null, stderr: "", stdout: "" }) }),
    ).rejects.toMatchObject({
      details: [{ exitCode: 2 }],
      nonRetryable: true,
      type: "ScriptFailed",
    });
  });

  it("fails without retrying when the script times out", async () => {
    await expect(
      execute({
        run: async () => {
          throw new ScriptTimeoutError(1000);
        },
      }),
    ).rejects.toMatchObject({ nonRetryable: true, type: "ScriptTimedOut" });
  });
});
