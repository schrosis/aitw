import type { WorkflowEvent } from "./event-sink.js";

/** Events of a run that {@link EventLog.read} returns, and where to continue reading. */
export interface EventPage {
  events: WorkflowEvent[];
  /** Position after the returned events. Pass it to the next read. */
  cursor: string;
}

/**
 * Port that stores the progress events of runs, so that any process can show them.
 *
 * The process that runs a step may differ from the process that shows the run, such as a
 * resident Worker and `ugoke run`. Both use the same log, keyed by the workflow ID.
 */
export interface EventLog {
  /**
   * Stores an event of a run.
   *
   * It returns after the event is stored, so that a read that starts later returns it.
   */
  append: (runId: string, event: WorkflowEvent) => void;
  /**
   * Returns the events of a run after a cursor, in the order they were stored.
   *
   * @param cursor Position from a previous read. Without it, the read starts from the first event.
   */
  read: (runId: string, cursor?: string) => Promise<EventPage>;
}
