import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { assert, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { CheckRequest, CheckResponse, TestRequest, TestResponse } from "./checker.ts";

// The checker's wire contract, shared with the Rust service's tests: fixtures/checker holds a JSON
// file per message, named after its schema, and invalid/ the messages both sides must refuse.
const SCHEMAS = { CheckRequest, TestRequest, CheckResponse, TestResponse };
const FIXTURES = NodePath.join(import.meta.dirname, "../fixtures/checker");

const fixtures = (dir: string) =>
  NodeFS.readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => {
      const schema = Object.entries(SCHEMAS).find(([key]) => name.startsWith(`${key}.`))?.[1];
      assert.isDefined(schema, `${name} names no schema`);
      const json: unknown = JSON.parse(NodeFS.readFileSync(NodePath.join(dir, name), "utf8"));
      return { name, schema, json };
    });

it("decodes every valid fixture and encodes it back to the same JSON", () => {
  const valid = fixtures(FIXTURES);
  assert.isAtLeast(valid.length, 16);
  for (const { name, schema, json } of valid) {
    const decoded = Schema.decodeUnknownSync(schema)(json);
    assert.deepStrictEqual(Schema.encodeUnknownSync(schema)(decoded), json, name);
  }
});

it("refuses every invalid fixture", () => {
  const invalid = fixtures(NodePath.join(FIXTURES, "invalid"));
  assert.isAtLeast(invalid.length, 34);
  for (const { name, schema, json } of invalid) {
    assert.throws(() => Schema.decodeUnknownSync(schema)(json), undefined, undefined, name);
  }
});

it("matches the committed JSON Schema of every message", async () => {
  const documents = Object.fromEntries(
    Object.entries(SCHEMAS).map(([name, schema]) => [name, Schema.toJsonSchemaDocument(schema)]),
  );
  await expect(`${JSON.stringify(documents, null, 2)}\n`).toMatchFileSnapshot(
    "../schema/checker.json",
  );
});
