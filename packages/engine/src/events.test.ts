import type { EventLog, WorkflowEvent } from "@aitw/core";
import { describe, expect, it } from "vitest";

import { createMemoryEventLog, followEvents } from "./events.ts";

const event = (text: string): WorkflowEvent => ({
  step: "build",
  stream: "stdout",
  text,
  type: "stepOutput",
});

describe("createMemoryEventLog", () => {
  it("reads events after a cursor", async () => {
    const log = createMemoryEventLog();
    log.append("run", event("a"));
    const first = await log.read("run");
    log.append("run", event("b"));
    log.append("other", event("c"));

    expect(first.events).toEqual([event("a")]);
    await expect(log.read("run", first.cursor)).resolves.toMatchObject({ events: [event("b")] });
  });
});

describe("followEvents", () => {
  it("delivers each event once, in order, and the remaining ones when it stops", async () => {
    const log = createMemoryEventLog();
    const delivered: WorkflowEvent[] = [];
    const follower = followEvents({
      intervalMs: 10,
      log,
      runId: "run",
      sink: { emit: (value) => delivered.push(value) },
    });

    log.append("run", event("a"));
    await follower.flush();
    expect(delivered).toEqual([event("a")]);

    log.append("run", event("b"));
    log.append("run", event("c"));
    await Promise.all([follower.flush(), follower.flush()]);
    log.append("run", event("d"));
    await follower.stop();

    expect(delivered).toEqual([event("a"), event("b"), event("c"), event("d")]);
  });

  it("reports a failed read and keeps following", async () => {
    let fail = true;
    const memory = createMemoryEventLog();
    const log: EventLog = {
      append: memory.append,
      read: async (runId, cursor) => {
        if (fail) {
          fail = false;
          throw new Error("read failed");
        }
        return memory.read(runId, cursor);
      },
    };
    const errors: unknown[] = [];
    const delivered: WorkflowEvent[] = [];
    const follower = followEvents({
      intervalMs: 10,
      log,
      onError: (error) => errors.push(error),
      runId: "run",
      sink: { emit: (value) => delivered.push(value) },
    });
    log.append("run", event("a"));

    await follower.flush();
    await follower.stop();

    expect(errors).toEqual([new Error("read failed")]);
    expect(delivered).toEqual([event("a")]);
  });
});
