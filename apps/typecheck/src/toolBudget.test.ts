import { assert, it } from "@effect/vitest";

import { toolBudget } from "./toolBudget.ts";

it("splits the cores between concurrent checks so their tools never ask for more threads", () => {
  assert.deepStrictEqual(toolBudget(10), { checks: 2, tsrsThreads: 4, oxlintThreads: 1 });
  for (let cores = 2; cores <= 64; cores++) {
    const { checks, tsrsThreads, oxlintThreads } = toolBudget(cores);
    assert.isAtMost(checks * (tsrsThreads + oxlintThreads), cores, `${cores} cores`);
  }
  assert.deepStrictEqual(toolBudget(1), { checks: 1, tsrsThreads: 1, oxlintThreads: 1 });
});
