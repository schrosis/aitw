import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** A temporary project directory for CLI tests. */
export interface TestProject {
  root: string;
  write: (path: string, content: string) => string;
  remove: () => void;
}

/** Creates a temporary project directory that contains `.aitw/workflows`. */
export const createTestProject = (): TestProject => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "aitw-project-")));
  mkdirSync(join(root, ".aitw", "workflows"), { recursive: true });
  return {
    remove: () => rmSync(root, { force: true, recursive: true }),
    root,
    write: (path, content) => {
      const file = join(root, path);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, content);
      return file;
    },
  };
};
