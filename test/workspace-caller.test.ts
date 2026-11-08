import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { RunRequest } from "../src/cli.js";
import { VERSION } from "../src/declaration.js";
import type { Answer, Call, Workspace } from "../src/dispatch.js";
import { METHODS } from "../src/methods/index.js";
import { PAGEHOST } from "../src/pagehost.js";
import { fakeBb } from "./fake-bb.js";
import { ok, rec } from "./fake-runner.js";
import { HEAD, SAMPLES, failureOf, harness, resultOf } from "./harness.js";

/**
 * A new-session page (unife-pages 05 R-S13, 07 R5.49, R5.84b): the host calls with `sessionId: null` and the workspace
 * it will start the session in. The plugin answers it as a session's page in that folder, the workspace's id standing
 * in for the session's as the write's `run` and the held-entry key (spec S2.1, S2.2, S2.33, S2.34, S1.5; A97–A103).
 */

const WS: Workspace = { id: "ws_9f2c4e", path: "/work/checkout", machine: "host_1" };
const SESSION = "thr_page";

/** A reply for every verb a sample runs, each a recorded success where one fits. */
const REPLIES = {
  share: (request: RunRequest) => rec(request.args.includes("--show") ? "share.show.shared.0313" : request.args.some((arg) => arg.startsWith("--visibility")) ? "share.visibility.0313" : "share.created.0313"),
  unshare: rec("unshare.kept.0313"),
  repo: rec("repo.visibility.0313"),
  "enable-checks": rec("enable-checks.none.0313"),
  explore: rec("explore.ok"),
  users: rec("users.ok"),
  collaborators: (request: RunRequest) => rec(({ add: "collaborators.add.ok", role: "collaborators.role.ok", remove: "collaborators.remove.ok" } as Record<string, string>)[request.args[1] ?? ""] ?? "collaborators.one"),
  cat: rec("cat.ok"),
  ls: rec("ls.ok"),
  history: rec("history.ok"),
  commit: rec("write.ok"),
  read: rec("read.ok"),
  glob: rec("glob.ok"),
  grep: rec("grep.content.ok"),
  diff: rec("diff.ok"),
  write: rec("write.ok"),
  edit: rec("write.ok"),
  rm: rec("write.ok"),
  mv: rec("mv.dir.0325"),
  cp: rec("cp.dir.0325"),
  revert: rec("write.ok"),
  whoami: rec("whoami.ok"),
  place: rec("place.ok"),
  status: rec("status.clean"),
};

type Harness = ReturnType<typeof harness>;
type Caller = Partial<Call["caller"]> & { sessionId: string | null };

/** A call from the new-session page of `workspace` (by default WS). */
const fromWorkspace = (h: Harness, method: string, params: unknown = {}, caller: Partial<Call["caller"]> = {}, workspace: unknown = WS): Promise<Answer> =>
  h.invoke({ method, params, caller: { sessionId: null, workspace: workspace as Workspace, ...caller }, requestId: "req_ws" });

/** The same call from a session's page in the same folder. */
const fromSession = (h: Harness, method: string, params: unknown = {}, caller: Partial<Call["caller"]> = {}): Promise<Answer> =>
  h.invoke({ method, params, caller: { sessionId: SESSION, workspace: WS, ...caller } as Caller, requestId: "req_ws" });

/** What a run is, but its signal and time limit, with the session's id written as the workspace's wherever it stands. */
const asRun = (request: RunRequest, from: string, to: string) => {
  const { signal: _signal, timeoutMs: _timeout, ...rest } = request;
  return JSON.parse(JSON.stringify(rest).split(from).join(to)) as Record<string, unknown>;
};

describe("a new-session page: no session yet, a workspace (S2.33, A97)", () => {
  it("every method runs the CLI in the workspace's folder on its machine, with the session page's argv, stdin and answer but run = the workspace's id; none answers no_repo without a run (W1)", async () => {
    for (const method of METHODS) {
      const session = harness(REPLIES);
      const workspace = harness(REPLIES);
      const bySession = await fromSession(session, method.name, SAMPLES[method.name]);
      const byWorkspace = await fromWorkspace(workspace, method.name, SAMPLES[method.name]);
      expect(workspace.runner.calls.length, method.name).toBeGreaterThan(0);
      expect(byWorkspace, method.name).toEqual(bySession);
      expect(workspace.runner.calls.map((call) => asRun(call, WS.id, SESSION)), method.name).toEqual(session.runner.calls.map((call) => asRun(call, "\u0000", "\u0000")));
      for (const call of workspace.runner.calls) {
        expect(call, method.name).toMatchObject({ hostId: "host_1", cwd: "/work/checkout" });
        expect(JSON.stringify(call.args), method.name).not.toContain(SESSION);
      }
      if (!byWorkspace.ok) expect(byWorkspace.error.reason, method.name).not.toBe("no_repo");
    }
  });

  it("a workspace whose machine is null runs on the local machine (W1)", async () => {
    const h = harness(REPLIES);
    resultOf(await fromWorkspace(h, "syns.repo", {}, {}, { ...WS, machine: null }));
    expect(h.runner.calls[0]).toMatchObject({ hostId: "local", cwd: "/work/checkout", args: ["repo", "--json"] });
  });

  it("writes carry --integration=syns-pages --trigger=page --run=<workspace id>; syns.enableChecks and syns.place carry SYNS_RUN=<workspace id> (W4, A98)", async () => {
    const h = harness(REPLIES);
    resultOf(await fromWorkspace(h, "syns.write", SAMPLES["syns.write"]));
    resultOf(await fromWorkspace(h, "syns.edit", SAMPLES["syns.edit"]));
    resultOf(await fromWorkspace(h, "syns.commit", SAMPLES["syns.commit"]));
    for (const call of h.runner.calls.filter((one) => ["write", "edit", "commit"].includes(one.args[0]!))) {
      expect(call.args, call.args[0]).toEqual(expect.arrayContaining(["--integration=syns-pages", "--trigger=page", `--run=${WS.id}`]));
    }
    expect(h.runner.calls.map((call) => call.args[0])).toEqual(["write", "edit", "commit"]);
    for (const name of ["syns.enableChecks", "syns.place"]) {
      const g = harness(REPLIES);
      resultOf(await fromWorkspace(g, name, SAMPLES[name]));
      const marked = g.runner.calls.filter((call) => call.env !== undefined);
      expect(marked, name).toHaveLength(1);
      expect(marked[0]!.env, name).toEqual({ SYNS_INTEGRATION: "syns-pages", SYNS_RUN: WS.id, SYNS_TRIGGER: "page" });
    }
  });

  it("once the session has started, the same document's next write carries the session's id (W5's half here, S1.5)", async () => {
    const h = harness(REPLIES);
    resultOf(await fromWorkspace(h, "syns.write", SAMPLES["syns.write"]));
    resultOf(await fromSession(h, "syns.write", SAMPLES["syns.write"]));
    expect(h.runner.calls.map((call) => call.args.find((arg) => arg.startsWith("--run=")))).toEqual([`--run=${WS.id}`, `--run=${SESSION}`]);
  });
});

describe("a new-session page's scopes are a session page's (S2.31, S2.32, D46, A99)", () => {
  /** The same call from both pages, against fresh harnesses: the same runs, the same answer (W6). */
  async function alike(method: string, params: Record<string, unknown>, caller: Partial<Call["caller"]>, replies: Record<string, unknown> = REPLIES) {
    const session = harness(replies as never);
    const workspace = harness(replies as never);
    const bySession = await fromSession(session, method, params, caller);
    const byWorkspace = await fromWorkspace(workspace, method, params, caller);
    expect(byWorkspace, method).toEqual(bySession);
    expect(workspace.runner.calls.map((call) => asRun(call, WS.id, SESSION)), method).toEqual(session.runner.calls.map((call) => asRun(call, "\u0000", "\u0000")));
    return { answer: byWorkspace, runs: workspace.runner.calls };
  }

  it("a call's scope: the CLI runs at the workspace's folder with the folder as scope, paths counted from it", async () => {
    const { answer, runs } = await alike("syns.write", { path: "list.json", text: "[]", base: HEAD, scope: "apps/todo" }, {});
    expect(answer.ok).toBe(true);
    expect(runs[0]).toMatchObject({ cwd: "/work/checkout", scope: "apps/todo" });
    expect(runs[0]!.args.slice(-2)).toEqual(["--", "apps/todo/list.json"]);
  });

  it("a document's scope: one repo --within check at the placed folder, then the method there", async () => {
    const { answer, runs } = await alike("syns.ls", {}, { scope: "clients/vela/crm" }, { ...REPLIES, repo: rec("repo.within.placed.2d706e8") });
    expect(answer.ok).toBe(true);
    expect(runs.map((call) => [call.cwd, call.args.join(" ")])).toEqual([
      ["/work/checkout/clients/vela/crm", "repo --within=/work/checkout --json"],
      ["/work/checkout/clients/vela/crm", "ls --json"],
    ]);
  });

  it("an app's frame: its folder is the call's scope; a read's ../ reaches the folder, a write's is bad_scope with no run, syns.place is bad_scope", async () => {
    const frame = { scope: "apps/todo", frame: { scope: "apps/todo", title: "Todo" } };
    const read = await alike("syns.read", { path: "../notes/a.md" }, frame);
    expect(read.answer.ok).toBe(true);
    expect(read.runs[0]).toMatchObject({ cwd: "/work/checkout", scope: "apps/todo" });
    const write = await alike("syns.write", { path: "../notes/a.md", text: "x", base: HEAD }, frame);
    expect(failureOf(write.answer).reason).toBe("bad_scope");
    expect(write.runs).toHaveLength(0);
    const place = await alike("syns.place", SAMPLES["syns.place"], frame);
    expect(failureOf(place.answer).reason).toBe("bad_scope");
    expect(place.runs).toHaveLength(0);
  });

  it("a plain folder as the document's scope is bad_scope, as on a session's page", async () => {
    const { answer } = await alike("syns.repo", {}, { scope: "notes" }, { ...REPLIES, repo: rec("repo.within.false.2d706e8") });
    expect(failureOf(answer).reason).toBe("bad_scope");
  });
});

describe("what still answers no_repo (S2.2, A100)", () => {
  it("the home, no session and no workspace: every method no_repo, no machine called (W7)", async () => {
    const h = harness(REPLIES);
    for (const method of METHODS) expect(failureOf(await fromWorkspace(h, method.name, SAMPLES[method.name], {}, null)), method.name).toMatchObject({ code: "unavailable", reason: "no_repo" });
    expect(h.runner.calls).toHaveLength(0);
  });

  it("a session with no workspace: every method no_repo, no machine called (W8)", async () => {
    const h = harness(REPLIES);
    for (const method of METHODS) expect(failureOf(await h.invoke({ method: method.name, params: SAMPLES[method.name], caller: { sessionId: SESSION, workspace: null }, requestId: "r" })), method.name).toMatchObject({ code: "unavailable", reason: "no_repo" });
    expect(h.runner.calls).toHaveLength(0);
  });
});

describe("a malformed workspace with no session is handler_error (S2.2, A100, W9)", () => {
  const MALFORMED: [string, unknown, RegExp][] = [
    ["a relative path", { ...WS, path: "work/checkout" }, /without an absolute path$/],
    ["a machine that is not text", { ...WS, machine: 7 }, /whose machine is neither text nor null$/],
    ["no id", { path: WS.path, machine: WS.machine }, /with no id and no session$/],
    ["an empty id", { ...WS, id: "" }, /with no id and no session$/],
    ["a blank id", { ...WS, id: "  " }, /with no id and no session$/],
    ["an id that is not text", { ...WS, id: 7 }, /with no id and no session$/],
    ["a string in place of the object", "/work/checkout", /without an absolute path$/],
  ];

  for (const [what, workspace, why] of MALFORMED) {
    it(`${what}: every method handler_error, one line naming it with session=none, no run`, async () => {
      for (const method of METHODS) {
        const h = harness(REPLIES);
        const error = failureOf(await fromWorkspace(h, method.name, SAMPLES[method.name], {}, workspace));
        expect(error.code, method.name).toBe("handler_error");
        expect(h.runner.calls, method.name).toHaveLength(0);
        // A write also leaves its record line, outcome=handler_error (S2.19); the warning is the other one.
        const warned = h.log.filter((line) => line.includes(" handler_error "));
        expect(warned, method.name).toHaveLength(1);
        expect(warned[0], method.name).toMatch(new RegExp(`^${method.name.replace(".", "\\.")} session=none handler_error `));
        expect(warned[0], method.name).toMatch(why);
        expect(h.log.join("\n"), method.name).not.toContain("work/checkout");
      }
    });
  }

  it("the page-script ask: null for the relative path, the bad machine and the string; the script for a missing or blank id, which the ask does not need", async () => {
    const ask = (workspace: unknown) => ({ caller: { sessionId: null, workspace }, documentPath: "index.html", have: null });
    const runs: unknown[] = [];
    const { handlers } = fakeBb({}, async (_method, input) => (runs.push(input), rec("repo.ok")));
    for (const workspace of [{ ...WS, path: "work/checkout" }, { ...WS, machine: 7 }, "/work/checkout"]) expect(await handlers.threadPagesPageScript!(ask(workspace))).toBeNull();
    expect(runs).toHaveLength(0);
    for (const workspace of [{ path: WS.path, machine: WS.machine }, { ...WS, id: "" }, { ...WS, id: "  " }]) {
      expect(await handlers.threadPagesPageScript!(ask(workspace))).toEqual({ version: VERSION, script: PAGEHOST });
    }
  });
});

describe("the page script for a new-session page (S2.27, A82, A102, W3)", () => {
  const ask = (have: string | null, workspace: unknown = WS) => ({ caller: { sessionId: null, workspace }, documentPath: "index.html", have });

  it("answers the script after one repo --json in the workspace's folder; only the version when the host holds it", async () => {
    const runs: { input: Record<string, unknown>; options: Record<string, unknown> }[] = [];
    const { handlers } = fakeBb({}, async (_method, input, options) => (runs.push({ input, options }), rec("repo.ok")));
    expect(await handlers.threadPagesPageScript!(ask(null))).toEqual({ version: VERSION, script: PAGEHOST });
    expect(runs).toEqual([{ input: expect.objectContaining({ cwd: "/work/checkout", args: ["repo", "--json"] }), options: expect.objectContaining({ hostId: "host_1" }) }]);
    expect(await handlers.threadPagesPageScript!(ask(VERSION))).toEqual({ version: VERSION });
  });

  it("answers null for a folder that is no repository, a relative path, or no workspace", async () => {
    const { handlers } = fakeBb({}, async () => rec("no-identity"));
    expect(await handlers.threadPagesPageScript!(ask(null))).toBeNull();
    const asked: unknown[] = [];
    const { handlers: other } = fakeBb({}, async (method) => (asked.push(method), rec("repo.ok")));
    expect(await other.threadPagesPageScript!(ask(null, { ...WS, path: "checkout" }))).toBeNull();
    expect(await other.threadPagesPageScript!(ask(null, null))).toBeNull();
    expect(asked).toEqual([]);
  });
});

describe("a new-session page of a folder that holds no Syns repository (A101, W10)", () => {
  it("every method answers no_repo from the CLI's own answer, but syns.whoami, syns.explore and syns.users (S1.12)", async () => {
    const replies = { ...Object.fromEntries(Object.keys(REPLIES).map((verb) => [verb, rec("no-identity")])), whoami: rec("whoami.ok"), explore: rec("explore.ok"), users: rec("users.ok") };
    for (const method of METHODS) {
      const h = harness(replies);
      const answer = await fromWorkspace(h, method.name, SAMPLES[method.name]);
      expect(h.runner.calls.length, method.name).toBeGreaterThan(0);
      if (["syns.whoami", "syns.explore", "syns.users"].includes(method.name)) expect(answer.ok, method.name).toBe(true);
      else expect(failureOf(answer), method.name).toMatchObject({ code: "unavailable", reason: "no_repo" });
    }
  });
});

describe("the plugin's lines on a new-session page (S2.34, A103, W11)", () => {
  it("a write: syns.write session=none workspace=<id> paths=1 outcome=ok", async () => {
    const h = harness(REPLIES);
    resultOf(await fromWorkspace(h, "syns.write", SAMPLES["syns.write"]));
    expect(h.log).toEqual([`syns.write session=none workspace=${WS.id} paths=1 outcome=ok`]);
  });

  it("a handler_error: … session=none workspace=<id> handler_error …, never the folder's path", async () => {
    const h = harness({ ls: rec("not-json"), write: rec("not-json") });
    expect(failureOf(await fromWorkspace(h, "syns.ls", {})).code).toBe("handler_error");
    expect(failureOf(await fromWorkspace(h, "syns.write", SAMPLES["syns.write"])).code).toBe("handler_error");
    expect(h.log[0]).toMatch(new RegExp(`^syns\\.ls session=none workspace=${WS.id} handler_error exit=0`));
    expect(h.log[1]).toMatch(new RegExp(`^syns\\.write session=none workspace=${WS.id} handler_error exit=0`));
    expect(h.log[2]).toBe(`syns.write session=none workspace=${WS.id} paths=1 outcome=handler_error`);
    expect(h.log.join("\n")).not.toContain("/work/checkout");
  });

  it("a dropped field says the same", async () => {
    const h = harness({ users: ok({ data: [{ id: "u1", username: "dana", name: 7, image: null }] }) });
    resultOf(await fromWorkspace(h, "syns.users", { query: "dana" }));
    expect(h.log).toEqual([`syns.users session=none workspace=${WS.id} dropped from the CLI's output: $.data[0].name`]);
  });

  it("a session's page still names its session alone", async () => {
    const h = harness(REPLIES);
    resultOf(await fromSession(h, "syns.write", SAMPLES["syns.write"]));
    expect(h.log).toEqual([`syns.write session=${SESSION} paths=1 outcome=ok`]);
  });
});

describe("held entries across the start (D25, D27, W14)", () => {
  const PIECE = 737_280;
  const picture = (size: number): Buffer => Buffer.alloc(size, 7);
  const sha256 = (data: Buffer): string => createHash("sha256").update(data).digest("hex");

  it("a picture gathered in pieces from the workspace, finished from the session, is bad_offset expecting 0; sent again from 0, it publishes", async () => {
    const data = picture(1_000_000);
    const h = harness({ write: rec("write.ok") });
    const common = { path: "images/a.png", base: HEAD, size: data.length, sha256: sha256(data) };
    const first = { ...common, offset: 0, base64: data.subarray(0, PIECE).toString("base64") };
    const rest = { ...common, offset: PIECE, base64: data.subarray(PIECE).toString("base64") };
    expect(resultOf(await fromWorkspace(h, "syns.writeBinary", first))).toEqual({ complete: false, received: PIECE });
    expect(failureOf(await fromSession(h, "syns.writeBinary", rest))).toMatchObject({ code: "conflict", reason: "bad_offset", detail: { expected: 0 } });
    resultOf(await fromSession(h, "syns.writeBinary", first));
    expect(resultOf(await fromSession(h, "syns.writeBinary", rest))).toMatchObject({ complete: true });
    expect(h.runner.calls).toHaveLength(1);
    expect(h.runner.calls[0]!.args).toContain(`--run=${SESSION}`);
  });

  it("a picture kept with hold: true from the workspace, committed from the session, is bad_offset expecting 0; kept again, it publishes", async () => {
    const data = picture(3_000);
    const h = harness({ commit: rec("write.ok") });
    const hold = { path: "images/a.png", base: HEAD, size: data.length, sha256: sha256(data), offset: 0, base64: data.toString("base64"), hold: true };
    const commit = { base: HEAD, files: [{ path: "images/a.png", upload: sha256(data) }] };
    expect(resultOf(await fromWorkspace(h, "syns.writeBinary", hold))).toMatchObject({ complete: true, upload: sha256(data) });
    expect(failureOf(await fromSession(h, "syns.commit", commit))).toMatchObject({ code: "conflict", reason: "bad_offset", detail: { expected: 0 } });
    resultOf(await fromSession(h, "syns.writeBinary", hold));
    resultOf(await fromSession(h, "syns.commit", commit));
    expect(h.runner.calls).toHaveLength(1);
    expect(h.runner.calls[0]!.args).toContain(`--run=${SESSION}`);
  });

  it("before the start, a picture kept from the workspace is committed from the workspace, with run = the workspace's id", async () => {
    const data = picture(3_000);
    const h = harness({ commit: rec("write.ok") });
    resultOf(await fromWorkspace(h, "syns.writeBinary", { path: "images/a.png", base: HEAD, size: data.length, sha256: sha256(data), offset: 0, base64: data.toString("base64"), hold: true }));
    resultOf(await fromWorkspace(h, "syns.commit", { base: HEAD, files: [{ path: "images/a.png", upload: sha256(data) }] }));
    expect(h.runner.calls[0]!.args).toContain(`--run=${WS.id}`);
  });
});
