import { assert, it } from "@effect/vitest";

import { filesWith, indexPart, plan } from "./words.ts";

it("plans the literal pieces every match must contain", () => {
  assert.deepStrictEqual(plan("thinkingCapabilities", "u"), [["thinkingCapabilities"]]);
  assert.deepStrictEqual(plan("Finish signing in", "u"), [["Finish", "signing"]]);
  assert.deepStrictEqual(plan("menu-placement", "u"), [["menu", "placement"]]);
  assert.deepStrictEqual(plan("aaa|bbbb|ccccc", "u"), [["aaa"], ["bbbb"], ["ccccc"]]);
  assert.deepStrictEqual(plan("is[A-Z][A-Za-z]+Level", "u"), [["Level"]]);
  assert.deepStrictEqual(plan("Saving\\.\\.\\.", "u"), [["Saving"]]);
  assert.deepStrictEqual(plan("export const \\w+Schema", "u"), [["export", "const", "Schema"]]);
  // An optional character leaves the text around it in separate pieces; a repeated one stays once.
  assert.deepStrictEqual(plan("colou?rful", "u"), [["colo", "rful"]]);
  assert.deepStrictEqual(plan("abcd+efg", "u"), [["abc", "efg"]]);
  // Groups and quantified groups say nothing.
  assert.deepStrictEqual(plan("(foo|bar)Service", "u"), [["Service"]]);
  assert.deepStrictEqual(plan("fooBar(Baz)?", "u"), [["fooBar"]]);
});

it("plans nothing when some match may lack a long enough piece", () => {
  assert.isUndefined(plan("^\\s*export", "i"));
  assert.isUndefined(plan("^\\s*$", "u"));
  assert.isUndefined(plan("foo|x", "u"));
  assert.isUndefined(plan("[a-z]+Id", "u"));
  assert.isUndefined(plan("(abc)", "u"));
});

it("finds the files with a word that contains a piece, and none from the offsets", () => {
  const index = indexPart([
    { offset: 0, text: "export const thinkingCapabilities = 1;" },
    { offset: 40, text: "const level = 2; // Finish signing in" },
    { offset: 4000, text: "binary 123" },
  ]);
  assert.deepStrictEqual([...filesWith(index, "Capabil")], [0]);
  assert.deepStrictEqual(
    [...filesWith(index, "const")].toSorted((a, b) => a - b),
    [0, 40],
  );
  assert.deepStrictEqual([...filesWith(index, "signing")], [40]);
  assert.deepStrictEqual([...filesWith(index, "123")], [4000]);
  // 40 is "14" in base 36, which must not count as a word.
  assert.deepStrictEqual([...filesWith(index, "14")], []);
  assert.deepStrictEqual([...filesWith(index, "nowhere")], []);
});
