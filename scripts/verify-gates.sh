#!/usr/bin/env bash
# Plants one error per tool, asserts the tool rejects it, then asserts `pnpm check` is green again.
set -euo pipefail
cd "$(dirname "$0")/.."

planted=()
cleanup() {
  if [ "${#planted[@]}" -gt 0 ]; then rm -f "${planted[@]}"; fi
  planted=()
}
trap cleanup EXIT
trap 'exit 130' INT TERM

plant() {
  planted+=("$1")
  printf '%s\n' "$2" >"$1"
}

expect_failure() {
  local name=$1 pattern=$2 out status=0
  shift 2
  out=$("$@" 2>&1) || status=$?
  if [ "$status" -eq 0 ]; then
    printf 'FAIL %s: `%s` exited 0 with a planted error\n' "$name" "$*" >&2
    exit 1
  fi
  if ! grep -qF -- "$pattern" <<<"$out"; then
    printf 'FAIL %s: `%s` exited %s without "%s"\n' "$name" "$*" "$status" "$pattern" >&2
    printf '%s\n' "$out" | tail -20 >&2
    exit 1
  fi
  printf 'ok   %s: exit %s, reported "%s"\n' "$name" "$status" "$pattern"
  cleanup
}

packages_with_script() {
  local manifest
  for manifest in apps/*/package.json packages/*/package.json; do
    [ -f "$manifest" ] || continue
    if node -e 'process.exit(require(process.argv[1]).scripts?.[process.argv[2]] ? 0 : 1)' "./$manifest" "$1"; then
      dirname "$manifest"
    fi
  done
}

if [ -n "$(git ls-files --others --exclude-standard -- '*__gate*')" ]; then
  echo "FAIL: stray __gate files from an earlier run" >&2
  exit 1
fi

plant __gate_format.ts 'export const gate   =   1'
expect_failure format "__gate_format.ts" pnpm fmt:check

plant __gate_lint.ts 'import { readFile } from "node:fs";
export const gate = readFile;'
expect_failure lint "dorbs(namespace-node-imports)" pnpm lint

for pkg in $(packages_with_script typecheck); do
  plant "$pkg/__gate_typecheck.ts" 'export const gate: number = "planted";'
  expect_failure "typecheck $pkg" "__gate_typecheck.ts(1,14): error TS2322" pnpm typecheck
done

for pkg in $(packages_with_script test); do
  plant "$pkg/__gate.test.ts" 'import { assert, it } from "@effect/vitest";

it("gate", () => {
  assert.strictEqual("planted", "gate");
});'
  expect_failure "test $pkg" "expected 'planted' to equal 'gate'" pnpm test
done

plant __gate_knip.ts 'export const gate = 1;'
expect_failure knip "__gate_knip.ts" pnpm knip

if ! out=$(pnpm check 2>&1); then
  printf 'FAIL: pnpm check is red after cleanup\n' >&2
  printf '%s\n' "$out" | tail -20 >&2
  exit 1
fi
if [ -n "$(git ls-files --others --exclude-standard -- '*__gate*')" ]; then
  echo "FAIL: planted files left behind" >&2
  exit 1
fi
echo "ok   pnpm check: green, no planted files left"
