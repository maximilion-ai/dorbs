/**
 * How many checks run at once and how many threads each check's tools get, so the tools of all
 * running checks ask for at most `cores` threads. tsrs and oxlint run side by side in a check.
 */
export const toolBudget = (cores: number) => {
  const tsrsThreads = Math.min(4, Math.max(1, cores - 1));
  return {
    checks: Math.max(1, Math.floor(cores / (tsrsThreads + 1))),
    tsrsThreads,
    oxlintThreads: 1,
  };
};
