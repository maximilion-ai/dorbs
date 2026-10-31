import type { Workspace } from "@cloudflare/computer";
import type { LifecycleCapability } from "agents/lifecycle";

import type { ModelProvider } from "./ModelProvider.ts";
import type { SessionHost, SessionRecord } from "./session.ts";
import type { ToolHost } from "./tools.ts";

export const SYSTEM_PROMPT =
  "You are a coding agent working in a cloned repo. Every path is relative to the workspace root. " +
  "Run the check tool after you change code, and the test tool on the tests that cover your change.";

/** What an agent loop needs from the AcpSession that hosts it. */
export type LoopHost = {
  readonly storage: DurableObjectStorage;
  readonly record: () => SessionRecord | undefined;
  /** The operation of a turn a restart cut off, which the session is about to run on. */
  readonly rejoining: () => string | undefined;
  readonly models: () => Promise<ModelProvider["Service"]>;
  readonly workspace: Workspace;
  readonly tools: ToolHost;
  readonly saveRecord: (record: SessionRecord) => void;
};

/**
 * One session's agent loop: the Lifecycle capability that keeps it in this object's storage and wakes it, and a run of
 * one prompt that emits the run's updates and resolves with how it ended, and a move to the model the session picked.
 */
export type Loop = {
  readonly capability: LifecycleCapability;
  readonly run: SessionHost["run"];
  readonly setModel: SessionHost["setModel"];
};
