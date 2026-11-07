/** Verifies that a Worker can bundle and execute a Workflow. */
export const smokeWorkflow = async (name: string): Promise<string> => {
  return `Hello, ${name}!`;
};
