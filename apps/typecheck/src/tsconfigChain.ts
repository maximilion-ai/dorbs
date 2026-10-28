import * as NodePath from "node:path";

import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";

import { RelativePath } from "@dorbs/protocol/typecheck";

// tsconfig files are JSON with comments and trailing commas; this drops both outside strings.
const parseJsonc = (text: string): unknown => {
  let json = "";
  for (let i = 0; i < text.length;) {
    if (text[i] === '"') {
      let end = i + 1;
      while (end < text.length && text[end] !== '"') end += text[end] === "\\" ? 2 : 1;
      json += text.slice(i, end + 1);
      i = end + 1;
    } else if (text.startsWith("//", i)) {
      const end = text.indexOf("\n", i);
      i = end === -1 ? text.length : end;
    } else if (text.startsWith("/*", i)) {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 2;
    } else if (
      text[i] === "," &&
      /^\s*(?:\/\/[^\n]*\s*|\/\*[\s\S]*?\*\/\s*)*[}\]]/.test(text.slice(i + 1))
    ) {
      i += 1;
    } else {
      json += text[i];
      i += 1;
    }
  }
  return JSON.parse(json);
};

const strings = (value: unknown): ReadonlyArray<string> =>
  typeof value === "string"
    ? [value]
    : Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : [];

const field = (value: unknown, key: string): unknown =>
  Predicate.hasProperty(value, key) ? value[key] : undefined;

/** Resolves `target` against the directory of `from`; undefined when it leaves the repo. */
const inRepo = (from: string, target: string): RelativePath | undefined => {
  if (NodePath.posix.isAbsolute(target)) return undefined;
  const joined = NodePath.posix.join(NodePath.posix.dirname(from), target).replace(/\/$/, "");
  return joined === "." || joined === ".." || joined.startsWith("../")
    ? undefined
    : RelativePath.make(joined);
};

/**
 * Every repo file the commit's tsconfig.json reaches through relative `extends` and project
 * `references`, whether or not it exists, so the client cannot supply or replace one. An extends
 * target counts with and without `.json`, since TypeScript tries both.
 */
export const tsconfigChain = Effect.fn("tsconfigChain")(function* (
  read: (path: RelativePath) => Effect.Effect<string | undefined>,
) {
  const chain = new Set<RelativePath>();
  const visited = new Set<RelativePath>();
  const visit = Effect.fn("tsconfigChain.visit")(function* (
    path: RelativePath,
  ): Effect.fn.Return<void> {
    chain.add(path);
    if (visited.has(path)) return;
    visited.add(path);
    const text = yield* read(path);
    if (text === undefined) return;
    // Fails closed: a config this cannot read could hide a chain member.
    const config = yield* Effect.try({
      try: () => parseJsonc(text),
      catch: (cause) => new Error(`${path} is not JSON with comments`, { cause }),
    }).pipe(Effect.orDie);
    for (const target of strings(field(config, "extends"))) {
      if (!target.startsWith("./") && !target.startsWith("../")) continue;
      const exact = inRepo(path, target);
      if (exact === undefined) continue;
      const withJson = exact.endsWith(".json") ? exact : RelativePath.make(`${exact}.json`);
      chain.add(exact);
      yield* visit((yield* read(exact)) === undefined ? withJson : exact);
      chain.add(withJson);
    }
    const references = field(config, "references");
    for (const reference of Array.isArray(references) ? references : []) {
      const [target] = strings(field(reference, "path"));
      const project = target === undefined ? undefined : inRepo(path, target);
      if (project === undefined) continue;
      yield* visit(
        project.endsWith(".json")
          ? project
          : RelativePath.make(NodePath.posix.join(project, "tsconfig.json")),
      );
    }
  });
  yield* visit(RelativePath.make("tsconfig.json"));
  return chain;
});
