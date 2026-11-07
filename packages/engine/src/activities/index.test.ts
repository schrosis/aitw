import { ScriptTimeoutError } from "@aitw/core";
import type { ScriptRunner, WorkflowEvent } from "@aitw/core";
import { MockActivityEnvironment } from "@temporalio/testing";
import { describe, expect, it } from "vitest";

import { createActivities } from "./index.ts";

const execute = async (scriptRunner: ScriptRunner, events: WorkflowEvent[] = []) =>
  new MockActivityEnvironment().run(
    createActivities({ eventSink: { emit: (event) => events.push(event) }, scriptRunner })
      .executeScriptStep,
    { input: {}, run: "./run.sh", step: "build", timeoutMs: 1000 },
  );

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

  it("reports the start and the success of a step", async () => {
    const events: WorkflowEvent[] = [];
    await execute(
      { run: async () => ({ exitCode: 0, signal: null, stderr: "", stdout: "" }) },
      events,
    );

    expect(events).toEqual([
      { run: "./run.sh", step: "build", type: "stepStarted" },
      {
        durationMs: expect.any(Number) as unknown,
        outcome: "succeeded",
        step: "build",
        type: "stepFinished",
      },
    ]);
  });

  it("reports a failed step with its reason", async () => {
    const events: WorkflowEvent[] = [];
    await execute(
      { run: async () => ({ exitCode: 3, signal: null, stderr: "", stdout: "" }) },
      events,
    ).catch(() => {});

    expect(events.at(-1)).toMatchObject({
      message: "Script exited with code 3",
      outcome: "failed",
      step: "build",
      type: "stepFinished",
    });
  });

  it("reports a cancelled step", async () => {
    const events: WorkflowEvent[] = [];
    const environment = new MockActivityEnvironment();
    const result = environment.run(
      createActivities({
        eventSink: { emit: (event) => events.push(event) },
        scriptRunner: {
          run: async (_request, { signal }) =>
            new Promise((_resolve, reject) => {
              signal.addEventListener("abort", () => reject(signal.reason));
            }),
        },
      }).executeScriptStep,
      { input: {}, run: "./run.sh", step: "build", timeoutMs: 1000 },
    );
    environment.cancel();

    await expect(result).rejects.toBeDefined();
    expect(events.at(-1)).toMatchObject({ outcome: "cancelled", step: "build" });
  });

  it("keeps the result of a step when the event sink fails", async () => {
    const environment = new MockActivityEnvironment();
    const result = environment.run(
      createActivities({
        eventSink: {
          emit: () => {
            throw new Error("sink failed");
          },
        },
        scriptRunner: { run: async () => ({ exitCode: 0, signal: null, stderr: "", stdout: "" }) },
      }).executeScriptStep,
      { input: {}, run: "./run.sh", step: "build", timeoutMs: 1000 },
    );

    await expect(result).resolves.toBeUndefined();
  });

  it("drops output that arrives after the script settles", async () => {
    const events: WorkflowEvent[] = [];
    let lateOutput: (() => void) | undefined;
    await execute(
      {
        run: async (_request, { onOutput }) => {
          onOutput?.({ stream: "stdout", text: "early\n" });
          lateOutput = () => onOutput?.({ stream: "stdout", text: "late\n" });
          return { exitCode: 0, signal: null, stderr: "", stdout: "" };
        },
      },
      events,
    );
    lateOutput?.();

    expect(events.map(({ type }) => type)).toEqual(["stepStarted", "stepOutput", "stepFinished"]);
  });
});
