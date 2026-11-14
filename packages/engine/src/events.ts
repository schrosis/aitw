import type { EventLog, EventSink, WorkflowEvent } from "@ugoke/core";

/**
 * Creates an event log in memory, for runs whose Worker and viewer share one process.
 *
 * Its cursors are indexes of the events of a run.
 */
export const createMemoryEventLog = (): EventLog => {
  const runs = new Map<string, WorkflowEvent[]>();
  return {
    append: (runId, event) => {
      const events = runs.get(runId) ?? [];
      events.push(event);
      runs.set(runId, events);
    },
    read: async (runId, cursor) => {
      const events = runs.get(runId) ?? [];
      const start = cursor === undefined ? 0 : Number(cursor);
      return { cursor: String(events.length), events: events.slice(start) };
    },
  };
};

/** Delivers the events of a run from a log to a sink. */
export interface EventFollower {
  /** Delivers the events that are stored now. */
  flush: () => Promise<void>;
  /** Delivers the remaining events and stops following. */
  stop: () => Promise<void>;
}

/** Options of {@link followEvents}. */
export interface FollowEventsOptions {
  log: EventLog;
  runId: string;
  sink: EventSink;
  /** Interval of reading new events, in milliseconds. */
  intervalMs?: number;
  /** Receives a failure to read the log or to deliver an event. Following continues. */
  onError?: (error: unknown) => void;
  /** Position to start after, from an earlier read. Without it, following starts from the first event. */
  cursor?: string | undefined;
}

/**
 * Follows the events of a run in a log and delivers them to a sink in order.
 *
 * Reads never overlap, so each event is delivered once.
 */
export const followEvents = ({
  cursor: start,
  intervalMs = 100,
  log,
  onError = () => {},
  runId,
  sink,
}: FollowEventsOptions): EventFollower => {
  let cursor = start;
  let reading: Promise<void> = Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const pull = (): Promise<void> => {
    reading = reading.then(async () => {
      try {
        const page = await log.read(runId, cursor);
        cursor = page.cursor;
        for (const event of page.events) {
          // A failing sink loses only its event, and the rest of the page is still delivered.
          try {
            sink.emit(event);
          } catch (error) {
            onError(error);
          }
        }
      } catch (error) {
        onError(error);
      }
    });
    return reading;
  };

  const schedule = (): void => {
    timer = setTimeout(() => {
      void pull().then(() => {
        if (!stopped) {
          schedule();
        }
      });
    }, intervalMs);
  };
  schedule();

  return {
    flush: pull,
    stop: async () => {
      stopped = true;
      clearTimeout(timer);
      await pull();
    },
  };
};
