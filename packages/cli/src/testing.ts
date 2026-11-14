import { fileURLToPath } from "node:url";

/** A project in the test fixtures that contains `.ugoke/workflows`. */
export const fixtureProject = fileURLToPath(new URL("../test/fixtures/project", import.meta.url));

/** Collects text written by a command. */
export const createOutput = () => {
  const written = { stderr: "", stdout: "" };
  return {
    stderr: (text: string) => {
      written.stderr += text;
    },
    stdout: (text: string) => {
      written.stdout += text;
    },
    written,
  };
};
