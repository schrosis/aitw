import { randomBytes } from "node:crypto";
import { linkSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { encryptionKeyBytes } from "@ugoke/engine";

import { stateDirectory } from "./state.js";

/** The encryption key of this host cannot be used. */
export class EncryptionKeyError extends Error {
  override name = "EncryptionKeyError";
}

const parseKey = (text: string, file: string): Uint8Array => {
  const hex = text.trim();
  if (!new RegExp(`^[0-9a-f]{${encryptionKeyBytes * 2}}$`, "u").test(hex)) {
    throw new EncryptionKeyError(
      `The encryption key in ${file} is invalid. Runs that use it cannot continue without it`,
    );
  }
  return Buffer.from(hex, "hex");
};

const readKey = (file: string): Uint8Array | undefined => {
  try {
    return parseKey(readFileSync(file, "utf8"), file);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
};

/**
 * Returns the key that encrypts what this host sends through Temporal, creating it when needed.
 *
 * The file appears with its whole content, so that another process never reads part of a key. Of
 * processes that create it at once, the first wins, and the others read its key.
 *
 * @throws {EncryptionKeyError} When the file does not hold a key.
 */
export const loadEncryptionKey = (): Uint8Array => {
  const directory = stateDirectory();
  const file = join(directory, "encryption.key");
  const existing = readKey(file);
  if (existing !== undefined) {
    return existing;
  }

  const temporary = join(directory, `encryption.key.${process.pid}`);
  writeFileSync(temporary, `${randomBytes(encryptionKeyBytes).toString("hex")}\n`, { mode: 0o600 });
  try {
    linkSync(temporary, file);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) {
      throw error;
    }
  } finally {
    rmSync(temporary, { force: true });
  }
  const created = readKey(file);
  if (created === undefined) {
    throw new EncryptionKeyError(`The encryption key in ${file} could not be created`);
  }
  return created;
};
