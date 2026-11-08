import { getEventListeners } from "node:events";
import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import { createLineReader } from "./lines.ts";

describe("createLineReader", () => {
  const signal = new AbortController().signal;

  it("reads lines without their endings and null at the end", async () => {
    const input = new PassThrough();
    const reader = createLineReader(input);
    input.end("first\r\nsecond\nlast");

    await expect(reader.readLine(signal)).resolves.toBe("first");
    await expect(reader.readLine(signal)).resolves.toBe("second");
    await expect(reader.readLine(signal)).resolves.toBe("last");
    await expect(reader.readLine(signal)).resolves.toBeNull();
  });

  it("removes its abort listener after each read", async () => {
    const input = new PassThrough();
    const reader = createLineReader(input);
    const controller = new AbortController();
    input.end("line\n".repeat(20));

    for (let index = 0; index < 20; index += 1) {
      await expect(reader.readLine(controller.signal)).resolves.toBe("line");
    }
    expect(getEventListeners(controller.signal, "abort")).toEqual([]);
  });

  it("keeps a line that arrives after an aborted read", async () => {
    const input = new PassThrough();
    const reader = createLineReader(input);
    const controller = new AbortController();
    const aborted = reader.readLine(controller.signal);
    controller.abort();

    await expect(aborted).rejects.toThrow();
    input.write("later\n");
    await expect(reader.readLine(signal)).resolves.toBe("later");
    reader.close();
  });
});
