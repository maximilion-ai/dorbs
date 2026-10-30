import type { ConnectionId } from "./rpc.ts";

/** One RPC to a connection, carrying messages in order. */
export type Deliver = (connection: ConnectionId, messages: ReadonlyArray<string>) => Promise<void>;

// A batch stays far under the 32 MiB RPC limit: at most 2 bytes per character as V8 serializes strings.
const BATCH_MESSAGES = 64;
const BATCH_CHARS = 8 * 1024 * 1024;

/**
 * Sends a session's messages to connections in order, one RPC at a time. Messages sent while an RPC is in flight
 * join one batch for the next RPC, so a fast stream costs few RPCs and a slow connection holds back the session's
 * sends rather than piling up concurrent calls.
 */
export const makeOutbox = (deliver: Deliver) => {
  let tail = Promise.resolve();
  let open: { connection: ConnectionId; messages: string[]; chars: number } | undefined;

  const enqueue = (work: () => Promise<void>) => {
    tail = tail.then(work).catch((error: unknown) => console.error("Could not deliver", error));
  };

  const send = (connection: ConnectionId, message: string): void => {
    if (
      open?.connection === connection &&
      open.messages.length < BATCH_MESSAGES &&
      open.chars + message.length <= BATCH_CHARS
    ) {
      open.messages.push(message);
      open.chars += message.length;
      return;
    }
    const batch = { connection, messages: [message], chars: message.length };
    open = batch;
    enqueue(() => {
      if (open === batch) open = undefined;
      return deliver(batch.connection, batch.messages);
    });
  };

  /** Sends `pages` after everything sent before, reading each page only once the one before it is delivered. */
  const replay = (connection: ConnectionId, pages: () => Iterable<ReadonlyArray<string>>): void => {
    open = undefined;
    enqueue(async () => {
      for (const page of pages()) await deliver(connection, page);
    });
  };

  return { send, replay };
};
