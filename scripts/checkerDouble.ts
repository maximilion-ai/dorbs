// The checker service as the agent Worker meets it, for the Worker's tests and the local e2e stack, which
// run where there is no Docker. Checks plant TS2322 wherever a number is initialised with a string;
// tests fail a file that expects 1 to be 2. GET /__log, /__requests, /__hold and /__release steer it.

type ChangeFile = { readonly path: string; readonly content: string };
type Body = {
  readonly repo: string;
  readonly commit: string;
  readonly change: {
    readonly files: ReadonlyArray<ChangeFile>;
    readonly deleted: ReadonlyArray<string>;
  };
  readonly only?: ReadonlyArray<string>;
  readonly files?: ReadonlyArray<string>;
  readonly filter?: string;
};

const CHECKS = ["typecheck", "lint"];

/** Whether a check tool result says every check passed: "<id> passed: <command>" lines and nothing failed. */
export const isCleanCheck = (text: string): boolean =>
  / passed: /.test(text) && !/ failed \(exit | timed out: |Not checked|error /.test(text);

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

const diagnose = (file: ChangeFile) =>
  file.content.split("\n").flatMap((line, index) => {
    const declared = /(\w+): number = "/.exec(line);
    if (declared === null) return [];
    const start = { line: index, character: declared.index };
    return [
      {
        path: file.path,
        range: { start, end: start },
        severity: 1,
        code: "TS2322",
        source: "tsc",
        message: "Type 'string' is not assignable to type 'number'.",
      },
    ];
  });

const TIMINGS = { envKey: "double", durationMs: 1, setupMs: 0, overlayMs: 0 };

/** `log` collects each request line; pass one to share it with other doubles. */
export const checkerDouble = (token: string, log: Array<string> = []) => {
  const requests: Array<Body> = [];
  /** While set, /check and /test wait until GET /__release. */
  let held: PromiseWithResolvers<void> | undefined;

  const check = (body: Body) => {
    const unknown = (body.only ?? []).filter((id) => !CHECKS.includes(id));
    if (unknown.length > 0) {
      return { _tag: "Rejected", reason: { _tag: "UnknownChecks", ids: unknown, known: CHECKS } };
    }
    const diagnostics = body.change.files.flatMap(diagnose);
    return {
      _tag: "CheckResult",
      ...TIMINGS,
      scope: "repo",
      complete: true,
      checks: CHECKS.filter((id) => body.only === undefined || body.only.includes(id)).map(
        (id) => ({
          id,
          command: `pnpm run ${id}`,
          status: id === "typecheck" && diagnostics.length > 0 ? "failed" : "passed",
          exitCode: id === "typecheck" && diagnostics.length > 0 ? 2 : 0,
          durationMs: 1,
          diagnostics: id === "typecheck" ? diagnostics : [],
          output: [],
          truncated: false,
        }),
      ),
    };
  };

  const test = (body: Body) => {
    const files = body.files ?? [];
    const failing = files.filter((path) =>
      body.change.files.some((file) => file.path === path && file.content.includes("toBe(2)")),
    );
    const passed = files.length - failing.length;
    const output = [
      ...files.map((path) => `${failing.includes(path) ? "×" : "✓"} ${path}`),
      `      Tests  ${failing.length > 0 ? `${failing.length} failed | ` : ""}${passed} passed (${files.length})`,
    ].join("\n");
    return {
      _tag: "TestResult",
      ...TIMINGS,
      command: `pnpm exec vitest run ${files.join(" ")}`.trim(),
      status: failing.length > 0 ? "failed" : "passed",
      exitCode: failing.length > 0 ? 1 : 0,
      passed,
      failed: failing.length,
      skipped: 0,
      output,
      truncated: false,
    };
  };

  const handle = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (url.pathname === "/__log") return json(log);
    if (url.pathname === "/__requests") return json(requests);
    if (url.pathname === "/__hold") {
      held = Promise.withResolvers();
      return json(true);
    }
    if (url.pathname === "/__release") {
      held?.resolve();
      held = undefined;
      return json(true);
    }
    if (request.headers.get("authorization") !== `Bearer ${token}`) {
      return new Response("Unauthorized", { status: 401 });
    }
    log.push(`${request.method} ${url.pathname}`);
    if (request.method !== "POST" || (url.pathname !== "/check" && url.pathname !== "/test")) {
      return new Response("Not found", { status: 404 });
    }
    await held?.promise;
    const body: Body = JSON.parse(await request.text());
    requests.push(body);
    return json(url.pathname === "/check" ? check(body) : test(body));
  };

  return { handle, log, requests };
};
