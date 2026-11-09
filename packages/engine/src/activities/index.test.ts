import { ScriptTimeoutError } from "@aitw/core";
import type {
  EventLog,
  ScriptRequest,
  ScriptResult,
  ScriptRunner,
  WorkflowEvent,
} from "@aitw/core";
import { MockActivityEnvironment } from "@temporalio/testing";
import { describe, expect, it } from "vitest";

import { maxValueBytes } from "../limits.ts";
import { createActivities } from "./index.ts";
import type { ScriptStepRequest } from "./index.ts";

/** An event log that collects the events of every run. */
const logTo = (events: WorkflowEvent[]): EventLog => ({
  append: (_runId, event) => {
    events.push(event);
  },
  read: async () => ({ cursor: "", events: [] }),
});

const execute = async (scriptRunner: ScriptRunner, events: WorkflowEvent[] = []) =>
  new MockActivityEnvironment().run(
    createActivities({ eventLog: logTo(events), scriptRunner }).executeScriptStep,
    { inputs: {}, outputs: {}, references: {}, run: "./run.sh", step: "build", timeoutMs: 1000 },
  );

const runStep = async (
  request: Partial<ScriptStepRequest>,
  result: Partial<ScriptResult> = {},
  requests: ScriptRequest[] = [],
) =>
  new MockActivityEnvironment().run(
    createActivities({
      scriptRunner: {
        run: async (scriptRequest) => {
          requests.push(scriptRequest);
          return { exitCode: 0, signal: null, stderr: "", stdout: "", ...result };
        },
      },
    }).executeScriptStep,
    {
      inputs: {},
      outputs: {},
      references: {},
      run: "./run.sh",
      step: "build",
      timeoutMs: 1000,
      ...request,
    },
  );

describe("executeScriptStep", () => {
  it("succeeds when the script exits with zero", async () => {
    await expect(
      execute({ run: async () => ({ exitCode: 0, signal: null, stderr: "", stdout: "secret" }) }),
    ).resolves.toEqual({});
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
        eventLog: logTo(events),
        scriptRunner: {
          run: async (_request, { signal }) =>
            new Promise((_resolve, reject) => {
              signal.addEventListener("abort", () => reject(signal.reason));
            }),
        },
      }).executeScriptStep,
      { inputs: {}, outputs: {}, references: {}, run: "./run.sh", step: "build", timeoutMs: 1000 },
    );
    environment.cancel();

    await expect(result).rejects.toBeDefined();
    expect(events.at(-1)).toMatchObject({ outcome: "cancelled", step: "build" });
  });

  it("keeps the result of a step when the event log fails", async () => {
    const environment = new MockActivityEnvironment();
    const result = environment.run(
      createActivities({
        eventLog: {
          append: () => {
            throw new Error("log failed");
          },
          read: async () => ({ cursor: "", events: [] }),
        },
        scriptRunner: { run: async () => ({ exitCode: 0, signal: null, stderr: "", stdout: "" }) },
      }).executeScriptStep,
      { inputs: {}, outputs: {}, references: {}, run: "./run.sh", step: "build", timeoutMs: 1000 },
    );

    await expect(result).resolves.toEqual({});
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

  it("expands input references in run", async () => {
    const requests: ScriptRequest[] = [];
    await runStep(
      { inputs: { title: "hello" }, run: './report.sh "${{ inputs.title }}"' },
      {},
      requests,
    );

    expect(requests).toEqual([
      { inputs: { title: "hello" }, run: './report.sh "hello"', timeoutMs: 1000 },
    ]);
  });

  it("expands references to earlier steps and the workflow input in run and output", async () => {
    const requests: ScriptRequest[] = [];
    const output = await runStep(
      {
        inputs: { suffix: "!" },
        outputs: { name: "${{ workflow.inputs.prefix }}-${{ result.stdout }}${{ inputs.suffix }}" },
        references: {
          steps: { fetch: { outputs: { title: "hello" } } },
          workflow: { inputs: { prefix: "pre" } },
        },
        run: 'echo "${{ steps.fetch.outputs.title }}"',
      },
      { stdout: "result\n" },
      requests,
    );

    expect(requests.map(({ run }) => run)).toEqual(['echo "hello"']);
    expect(output).toEqual({ name: "pre-result!" });
  });

  it("keeps the step input when references contain an input entry", async () => {
    const requests: ScriptRequest[] = [];
    await runStep(
      {
        inputs: { title: "own" },
        references: { inputs: { title: "other" } },
        run: "${{ inputs.title }}",
      },
      {},
      requests,
    );

    expect(requests.map(({ run }) => run)).toEqual(["own"]);
  });

  it("returns the declared output with one trailing newline removed", async () => {
    await expect(
      runStep(
        {
          outputs: {
            code: "${{ result.exitCode }}",
            lines: "${{ result.stdout }}",
            title: "[${{ result.stdout }}]",
          },
        },
        { stdout: "a\nb\n\n" },
      ),
    ).resolves.toEqual({ code: 0, lines: "a\nb\n", title: "[a\nb\n]" });
  });

  it.each([
    [{ run: "${{ inputs.missing }}" }, "run: Unknown reference: ${{ inputs.missing }}"],
    [
      { outputs: { title: "${{ result.missing }}" } },
      "outputs.title: Unknown reference: ${{ result.missing }}",
    ],
  ])("fails without retrying on an invalid expression", async (request, message) => {
    await expect(runStep(request)).rejects.toMatchObject({
      message,
      nonRetryable: true,
      type: "InvalidExpression",
    });
  });

  it("fails when the output exceeds the size limit", async () => {
    await expect(
      runStep({ outputs: { data: "${{ result.stdout }}" } }, { stdout: "x".repeat(maxValueBytes) }),
    ).rejects.toMatchObject({ nonRetryable: true, type: "OutputTooLarge" });
  });
});
