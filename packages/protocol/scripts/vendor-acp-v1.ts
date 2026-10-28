import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const UPSTREAM = "packages/effect-acp/src/_generated/schema-v1.gen.ts";
const TARGET = NodePath.join(import.meta.dirname, "..", "src", "acp.ts");
const ROOTS = [
  "InitializeRequest",
  "InitializeResponse",
  "NewSessionRequest",
  "NewSessionResponse",
  "PromptRequest",
  "PromptResponse",
  "CancelNotification",
  "SessionNotification",
  "RequestPermissionRequest",
  "RequestPermissionResponse",
];

const t3Root = process.argv[2];
if (t3Root === undefined) {
  console.error("usage: node scripts/vendor-acp-v1.ts <t3code checkout>");
  process.exit(1);
}

const commit = NodeChildProcess.execFileSync(
  "git",
  ["-C", t3Root, "rev-parse", "--short=7", "HEAD"],
  {
    encoding: "utf8",
  },
).trim();
const source = NodeFS.readFileSync(NodePath.join(t3Root, UPSTREAM), "utf8");

// The generated file is one import followed by `export type X` / `export const X` pairs.
const declarations = new Map<string, Array<string>>();
for (const statement of source.split(/\n(?=export )/).slice(1)) {
  const name = /^export (?:type|const) (\w+)/.exec(statement)?.[1];
  if (name === undefined) throw new Error(`unexpected statement: ${statement.slice(0, 80)}`);
  declarations.set(name, [...(declarations.get(name) ?? []), statement.trimEnd()]);
}

// Descriptions mention other type names in prose, so strip strings before collecting references.
const references = (name: string): Array<string> => {
  const code = (declarations.get(name) ?? []).join("\n").replaceAll(/"(?:[^"\\]|\\.)*"/g, '""');
  const identifiers = code.match(/(?<![.\w])[A-Z]\w*/g) ?? [];
  return identifiers.filter((id) => id !== name && declarations.has(id));
};

const keep = new Set<string>();
const pending = [...ROOTS];
for (let name = pending.pop(); name !== undefined; name = pending.pop()) {
  if (!declarations.has(name)) throw new Error(`no declaration named ${name}`);
  if (keep.has(name)) continue;
  keep.add(name);
  pending.push(...references(name));
}

const header = `// Vendored from T3 Code (https://github.com/pingdotgg/t3code) ${UPSTREAM}
// at commit ${commit}, MIT (see THIRD_PARTY_LICENSES). Keeps only what these roots reach:
// ${ROOTS.join(", ")}.
// Regenerate with \`node packages/protocol/scripts/vendor-acp-v1.ts <t3code checkout> && pnpm fmt\`.
import * as Schema from "effect/Schema";
`;
const body = [...declarations]
  .filter(([name]) => keep.has(name))
  .flatMap(([, statements]) => statements);
NodeFS.writeFileSync(TARGET, `${header}\n${body.join("\n\n")}\n`);
console.log(`kept ${keep.size} of ${declarations.size} declarations in ${TARGET}`);
