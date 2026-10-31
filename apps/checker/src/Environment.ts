import type { CommitSha } from "@dorbs/protocol/typecheck";

/**
 * Where an environment is in its life: one repo at one recipe, key-file content and image, shared by
 * every thread on the repo, one run at a time. Absent → SettingUp → Ready ⇄ Busy; SettingUp → Failed;
 * Ready ⇄ Idle, its container stopped; Ready, Idle and Failed → Evicted; Failed and Evicted → SettingUp.
 */
export type EnvState =
  | { readonly _tag: "Absent" }
  | { readonly _tag: "SettingUp" }
  | { readonly _tag: "Ready"; readonly tree: CommitSha; readonly lastUsed: number }
  | { readonly _tag: "Busy"; readonly tree: CommitSha; readonly lastUsed: number }
  | { readonly _tag: "Idle"; readonly tree: CommitSha; readonly lastUsed: number }
  | { readonly _tag: "Failed"; readonly step: string; readonly output: string }
  | { readonly _tag: "Evicted" };

export type EnvEvent =
  | { readonly _tag: "SetupStarted" }
  | { readonly _tag: "SetupSucceeded"; readonly tree: CommitSha; readonly at: number }
  | { readonly _tag: "SetupFailed"; readonly step: string; readonly output: string }
  | { readonly _tag: "Acquired" }
  /** A run ended; the tree is at `tree` again, with no change laid over it. */
  | { readonly _tag: "Released"; readonly tree: CommitSha; readonly at: number }
  | { readonly _tag: "Stopped" }
  | { readonly _tag: "Started" }
  | { readonly _tag: "Evicted" };

export class IllegalTransition extends Error {
  constructor(state: EnvState, event: EnvEvent) {
    super(`An environment in ${state._tag} cannot take ${event._tag}`);
  }
}

/** The state after `event`; throws on an event the state cannot take, which is a bug in the caller. */
export const transition = (state: EnvState, event: EnvEvent): EnvState => {
  switch (event._tag) {
    case "SetupStarted":
      if (state._tag === "Absent" || state._tag === "Failed" || state._tag === "Evicted") {
        return { _tag: "SettingUp" };
      }
      break;
    case "SetupSucceeded":
      if (state._tag === "SettingUp")
        return { _tag: "Ready", tree: event.tree, lastUsed: event.at };
      break;
    case "SetupFailed":
      if (state._tag === "SettingUp") {
        return { _tag: "Failed", step: event.step, output: event.output };
      }
      break;
    case "Acquired":
      if (state._tag === "Ready") return { ...state, _tag: "Busy" };
      break;
    case "Released":
      if (state._tag === "Busy") return { _tag: "Ready", tree: event.tree, lastUsed: event.at };
      break;
    case "Stopped":
      if (state._tag === "Ready") return { ...state, _tag: "Idle" };
      break;
    case "Started":
      if (state._tag === "Idle") return { ...state, _tag: "Ready" };
      break;
    case "Evicted":
      if (state._tag === "Ready" || state._tag === "Idle" || state._tag === "Failed") {
        return { _tag: "Evicted" };
      }
      break;
  }
  throw new IllegalTransition(state, event);
};
