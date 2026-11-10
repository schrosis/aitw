import { randomBytes } from "node:crypto";

import type { Payload } from "@temporalio/common";
import { describe, expect, it } from "vitest";

import { createEncryptionCodec, encryptedEncoding } from "./encryption.ts";

const key = randomBytes(32);

const payload: Payload = {
  data: Buffer.from('{"run":"echo secret"}'),
  metadata: { encoding: Buffer.from("json/plain"), other: Buffer.from([0, 255]) },
};

const encodeOne = async (value: Payload, codec = createEncryptionCodec(key)): Promise<Payload> => {
  const [encoded] = await codec.encode([value]);
  if (encoded === undefined) {
    throw new Error("Nothing was encoded");
  }
  return encoded;
};

describe("createEncryptionCodec", () => {
  it("restores the data and every metadata entry", async () => {
    const codec = createEncryptionCodec(key);

    const [decoded] = await codec.decode([await encodeOne(payload)]);

    expect(Buffer.from(decoded?.data ?? []).toString()).toBe('{"run":"echo secret"}');
    expect(Buffer.from(decoded?.metadata?.encoding ?? []).toString()).toBe("json/plain");
    expect([...(decoded?.metadata?.other ?? [])]).toEqual([0, 255]);
  });

  it("hides the value and its encoding", async () => {
    const encoded = await encodeOne(payload);

    expect(Buffer.from(encoded.data ?? []).toString("latin1")).not.toContain("secret");
    expect(Object.keys(encoded.metadata ?? {})).toEqual(["encoding"]);
    expect(Buffer.from(encoded.metadata?.encoding ?? []).toString()).toBe(encryptedEncoding);
  });

  it("uses a new nonce each time", async () => {
    const first = await encodeOne(payload);
    const second = await encodeOne(payload);

    expect(Buffer.from(first.data ?? []).equals(Buffer.from(second.data ?? []))).toBe(false);
  });

  it("refuses a value that is not encrypted", async () => {
    await expect(createEncryptionCodec(key).decode([payload])).rejects.toThrow(
      "Refused a value that is not encrypted",
    );
  });

  it("refuses a value that was changed", async () => {
    const encoded = await encodeOne(payload);
    const data = Buffer.from(encoded.data ?? []);
    data[data.length - 1] = (data.at(-1) ?? 0) ^ 1;

    await expect(createEncryptionCodec(key).decode([{ ...encoded, data }])).rejects.toThrow(
      "cannot be decrypted",
    );
  });

  it("refuses a value of another key", async () => {
    const encoded = await encodeOne(payload, createEncryptionCodec(randomBytes(32)));

    await expect(createEncryptionCodec(key).decode([encoded])).rejects.toThrow(
      "cannot be decrypted",
    );
  });

  it("passes on plaintext when it is allowed, and still decrypts", async () => {
    const codec = createEncryptionCodec(key, { allowPlaintext: true });

    await expect(codec.decode([payload])).resolves.toEqual([payload]);
    const [decoded] = await codec.decode([await encodeOne(payload)]);
    expect(Buffer.from(decoded?.data ?? []).toString()).toContain("secret");
  });

  it("rejects a key of the wrong size", () => {
    expect(() => createEncryptionCodec(randomBytes(16))).toThrow("must have 32 bytes");
  });
});
