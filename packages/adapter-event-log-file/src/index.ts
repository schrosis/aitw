import { closeSync, constants, lstatSync, mkdirSync, openSync, writeSync } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";

import { workflowEventSchema } from "@aitw/core";
import type { EventLog, WorkflowEvent } from "@aitw/core";

/** Options of {@link createFileEventLog}. */
export interface FileEventLogOptions {
  /**
   * Directory that keeps the runs of a project, such as
   * `~/.local/state/aitw/logs/<project hash>`.
   */
  directory: string;
}

/** Name of the file that keeps the events of a run, in the directory of the run. */
export const eventsFileName = "events.jsonl";

/** Size of a chunk that a read takes from a file, in bytes. */
const readChunkBytes = 64 * 1024;

const isNotFound = (error: unknown): boolean =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

/**
 * Parses a line of the log. A line that is not an event is skipped, so that a damaged line does
 * not stop the rest of the run from being shown.
 */
const parseEvent = (line: string): WorkflowEvent[] => {
  if (line === "") {
    return [];
  }
  try {
    const parsed = workflowEventSchema.safeParse(JSON.parse(line));
    return parsed.success ? [parsed.data] : [];
  } catch {
    return [];
  }
};

/**
 * Creates a directory that only the user can use, and checks that it is not a symbolic link.
 *
 * A symbolic link could make the log write into a file that the user did not intend.
 */
const ensureDirectory = (path: string): void => {
  mkdirSync(path, { mode: 0o700, recursive: true });
  if (!lstatSync(path).isDirectory()) {
    throw new Error(`Expected a directory for the event log: ${path}`);
  }
};

/**
 * Creates an event log that keeps each run in `<directory>/<run ID>/events.jsonl`.
 *
 * Events are JSON Lines, so that processes on the same machine can append and read them. The
 * run ID is encoded, because workflow IDs contain `/` for workflows in subdirectories.
 * Directories are created with `700` and files with `600`, and symbolic links are not followed.
 */
export const createFileEventLog = ({ directory }: FileEventLogOptions): EventLog => {
  const runDirectory = (runId: string): string => {
    // encodeURIComponent keeps dots, and these names would point outside of the directory.
    if (runId === "" || runId === "." || runId === "..") {
      throw new Error(`Invalid run ID for the event log: ${runId}`);
    }
    return join(directory, encodeURIComponent(runId));
  };
  const eventsFile = (runId: string): string => join(runDirectory(runId), eventsFileName);
  // Directories that were checked once are not checked again, because output arrives in many
  // small events.
  const checked = new Set<string>();
  const ensureChecked = (path: string): void => {
    if (!checked.has(path)) {
      ensureDirectory(path);
      checked.add(path);
    }
  };

  return {
    append: (runId, event) => {
      ensureChecked(directory);
      ensureChecked(runDirectory(runId));
      const descriptor = openSync(
        eventsFile(runId),
        constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        // One write per event keeps lines whole when several processes append.
        writeSync(descriptor, `${JSON.stringify(event)}\n`);
      } finally {
        closeSync(descriptor);
      }
    },
    read: async (runId, cursor) => {
      const start = cursor === undefined ? 0 : Number(cursor);
      let file;
      try {
        file = await open(eventsFile(runId), constants.O_RDONLY | constants.O_NOFOLLOW);
      } catch (error) {
        // A run that has not stored an event yet has no file.
        if (isNotFound(error)) {
          return { cursor: String(start), events: [] };
        }
        throw error;
      }
      try {
        const chunks: Buffer[] = [];
        let position = start;
        for (;;) {
          const buffer = Buffer.alloc(readChunkBytes);
          const { bytesRead } = await file.read(buffer, 0, readChunkBytes, position);
          if (bytesRead === 0) {
            break;
          }
          chunks.push(buffer.subarray(0, bytesRead));
          position += bytesRead;
        }
        const content = Buffer.concat(chunks);
        // A line that is still being written is read next time.
        const end = content.lastIndexOf(0x0a) + 1;
        const events = content
          .subarray(0, end)
          .toString("utf8")
          .split("\n")
          .flatMap((line): WorkflowEvent[] => parseEvent(line));
        return { cursor: String(start + end), events };
      } finally {
        await file.close();
      }
    },
  };
};
