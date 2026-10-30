import type { Workspace } from "@cloudflare/computer";
import type { LifecycleCapability } from "agents/lifecycle";

import type { ModelProvider } from "./ModelProvider.ts";
import type { SessionHost, SessionRecord } from "./session.ts";
import type { ToolHost } from "./tools.ts";

export const SYSTEM_PROMPT =
  "You are a coding agent working in a TypeScript workspace. Every path is relative to the workspace root. " +
  "Run the typecheck tool after you change code.";

/** What an agent loop needs from the AcpSession that hosts it. */
export type LoopHost = {
  readonly storage: DurableObjectStorage;
  readonly models: () => Promise<ModelProvider["Service"]>;
  readonly workspace: Workspace;
  readonly tools: ToolHost;
  readonly saveRecord: (record: SessionRecord) => void;
};

/**
 * One session's agent loop: the Lifecycle capability that keeps it in this object's storage and wakes it, and a run of
 * one prompt that emits the run's updates and resolves with how it ended.
 */
export type Loop = {
  readonly capability: LifecycleCapability;
  readonly run: SessionHost["run"];
};
