import * as NodePath from "node:path";

import * as Schema from "effect/Schema";

import { RelativePath } from "@dorbs/protocol/typecheck";

import type { Command, TestCommand } from "./Recipe.ts";

const isRelativePath = Schema.is(RelativePath);

/** `value` as one POSIX shell word. */
export const quote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

const words = (values: ReadonlyArray<string>) => values.map((value) => ` ${quote(value)}`).join("");

type Refused = { readonly reason: string };

/** The commands that run a test request: one, or one per workspace package. */
export const testCommands = (
  test: TestCommand,
  request: { readonly files?: ReadonlyArray<string>; readonly filter?: string },
  workspaceDirs: ReadonlyArray<string>,
): ReadonlyArray<Command> | Refused => {
  const files = request.files ?? [];
  for (const file of files) {
    // A pytest id names its test after ::.
    if (!isRelativePath(file.split("::")[0]))
      return { reason: `${file} is not a path inside the repo.` };
  }
  if (request.filter !== undefined && test.filterFlag === undefined) {
    return { reason: "This repo's test command takes no name filter. Pass files instead." };
  }
  const filter =
    request.filter === undefined
      ? ""
      : test.filterFlag === ""
        ? words([request.filter])
        : ` ${test.filterFlag} ${quote(request.filter)}`;
  const command = (run: string): Command => ({ run: `${run}${filter}`, cwd: test.cwd });

  if (test.target === "filter") {
    if (files.length > 0) {
      return {
        reason: "This repo's test command takes a name filter, not files. Pass filter instead.",
      };
    }
    return [command(test.run)];
  }
  if (test.target === "packages") {
    const packages = [...new Set(files.map((file) => NodePath.posix.dirname(file)))].map((dir) =>
      dir === "." ? "." : `./${dir}`,
    );
    return [command(`${test.run}${words(packages.length === 0 ? ["./..."] : packages)}`)];
  }
  if (test.target === "files") {
    const prefix = test.cwd === "." ? "" : `${test.cwd}/`;
    const outside = files.find((file) => !file.startsWith(prefix));
    if (outside !== undefined)
      return { reason: `${outside} is outside ${test.cwd}, where the tests run.` };
    return [command(`${test.run}${words(files.map((file) => file.slice(prefix.length)))}`)];
  }
  // What is left is the workspace target.
  if (files.length === 0) {
    return {
      reason: "This repo's tests run per workspace package. Pass the test files to run.",
    };
  }
  const packages = workspaceDirs
    .filter((dir) => dir !== ".")
    .toSorted((a, b) => b.length - a.length);
  const groups = new Map<string, Array<string>>();
  for (const file of files) {
    const dir = packages.find((candidate) => file.startsWith(`${candidate}/`));
    if (dir === undefined) return { reason: `${file} is in no workspace package.` };
    groups.set(dir, [...(groups.get(dir) ?? []), file.slice(dir.length + 1)]);
  }
  return [...groups]
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([dir, inDir]) => command(`${test.run.replaceAll("{dir}", quote(dir))}${words(inDir)}`));
};
