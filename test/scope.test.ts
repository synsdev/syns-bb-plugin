import { describe, expect, it } from "vitest";
import { rec } from "./fake-runner.js";
import { failureOf, harness, resultOf } from "./harness.js";

/** A call from a document that set a scope (D43). The host's exact field may still change. */
const scoped = (h: ReturnType<typeof harness>, scope: string | null | undefined, method = "syns.repo", params: unknown = {}) =>
  h.invoke({ method, params, caller: { sessionId: "thr_page", scope: scope as string | null }, requestId: "r" });

/** `repo --json` at the session's root (acme/work) and in a folder placed in it, or in another repository. */
const ROOT = { owner: "acme", name: "work", commitSha: "7ca9bc78ba047d9e7798b8d2733c254e24cfc837", version: 5, role: "owner", visibility: "private", fileCount: 40 };
const PLACED = { ...ROOT, holder: "acme/work", path: "clients/vela/q3-board" };
const answer = (doc: unknown) => ({ exitCode: 0, stdout: JSON.stringify(doc), stderr: "", timedOut: false, spawnError: null, overflowed: false });
/** `repo [--within=…] --json` by folder: with --within the CLI adds `within`, from disk (roadmap 277). */
const repoBy = (byCwd: Record<string, Record<string, unknown>>, within: Record<string, boolean | undefined> = {}) => (request: { cwd: string; args: string[] }) => {
  const doc = byCwd[request.cwd];
  if (doc === undefined) return rec("no-identity");
  const asked = request.args.find((arg) => arg.startsWith("--within="));
  if (!asked) return answer(doc);
  const verdict = request.cwd in within ? within[request.cwd] : true;
  return answer(verdict === undefined ? doc : { ...doc, within: verdict });
};
const SCOPE = "/work/checkout/clients/vela/q3-board";

describe("a document's scope: one check run (D46 as amended, D83; rows 13–19)", () => {
  it("runs one check at the scope, repo --within=<session folder> --json, then the method's own run; nothing at the session's folder (row 13)", async () => {
    const h = harness({ repo: repoBy({ [SCOPE]: PLACED }), ls: rec("ls.ok") });
    expect((await scoped(h, "clients/vela/q3-board", "syns.ls", {})).ok).toBe(true);
    expect(h.runner.calls.map((call) => [call.cwd, call.within, call.args.join(" ")])).toEqual([
      [SCOPE, "/work/checkout", "repo --within=/work/checkout --json"],
      [SCOPE, "/work/checkout", "ls --json"],
    ]);
  });
  it("a scoped syns.ls is 2 runs on the first call of a minute and 1 inside the hold; the hold expires at 60 s (rows 13, 18)", async () => {
    let clock = 1_000_000;
    const h = harness({ repo: repoBy({ [SCOPE]: PLACED }), ls: rec("ls.ok") }, { now: () => clock });
    await scoped(h, "clients/vela/q3-board", "syns.ls", {});
    expect(h.runner.calls).toHaveLength(2);
    clock += 59_000;
    await scoped(h, "clients/vela/q3-board", "syns.ls", {});
    expect(h.runner.calls).toHaveLength(3);
    clock += 2_000;
    await scoped(h, "clients/vela/q3-board", "syns.ls", {});
    expect(h.runner.calls.map((call) => call.args[0])).toEqual(["repo", "ls", "ls", "repo", "ls"]);
  });
  it("within: false or absent is bad_scope, and the method does not run (row 14)", async () => {
    for (const verdict of [false, undefined]) {
      const h = harness({ repo: repoBy({ [SCOPE]: PLACED }, { [SCOPE]: verdict }), ls: rec("ls.ok") });
      expect(failureOf(await scoped(h, "clients/vela/q3-board", "syns.ls", {})), String(verdict)).toMatchObject({ code: "invalid_params", reason: "bad_scope" });
      // The one check ran at the scope with --within, and its answer, not a missing session record, refused it.
      expect(h.runner.calls.map((call) => [call.cwd, call.args.join(" ")]), String(verdict)).toEqual([[SCOPE, "repo --within=/work/checkout --json"]]);
    }
  });
  it("the recorded answers: within true in a placed folder holds; within false is bad_scope (row 14)", async () => {
    const yes = harness({ repo: rec("repo.within.placed.2d706e8") });
    expect(resultOf(await scoped(yes, "clients/vela/board"))).toMatchObject({ owner: "ana-t", holder: "ana-t/r280-build-scratch", path: "clients/vela/board" });
    const no = harness({ repo: rec("repo.within.false.2d706e8") });
    expect(failureOf(await scoped(no, "clients/vela/board"))).toMatchObject({ reason: "bad_scope" });
    // --within naming a folder that is not there: within false.
    const missing = harness({ repo: rec("repo.within.missing.2d706e8") });
    expect(failureOf(await scoped(missing, "clients/vela/board"))).toMatchObject({ reason: "bad_scope" });
    // At a root, within itself: true.
    const root = harness({ repo: rec("repo.within.root.2d706e8") });
    expect(resultOf(await scoped(root, "sub"))).toMatchObject({ owner: "ana-t", name: "r280-build-scratch" });
  });
  it("no_repo and no_access from the check run are bad_scope (row 14)", async () => {
    expect(failureOf(await scoped(harness({ repo: rec("no-identity") }), "clients/vela/q3-board"))).toMatchObject({ reason: "bad_scope" });
    const h = harness({ repo: rec("not-found-404"), whoami: rec("whoami.ok") });
    expect(failureOf(await scoped(h, "clients/vela/q3-board"))).toMatchObject({ reason: "bad_scope" });
    expect(h.runner.calls.map((call) => [call.cwd, call.args[0]])).toEqual([[SCOPE, "repo"], ["/work/checkout", "whoami"]]);
  });
  it("not_logged_in comes from whoami at the session's folder, run only after the check's 404 (row 14, D82, B-0011)", async () => {
    const h = harness({ repo: rec("signed-out.repo"), whoami: rec("auth-required") });
    expect(failureOf(await scoped(h, "clients/vela/q3-board"))).toMatchObject({ code: "unavailable", reason: "not_logged_in" });
    expect(h.runner.calls.map((call) => [call.cwd, call.within, call.args[0]])).toEqual([[SCOPE, "/work/checkout", "repo"], ["/work/checkout", undefined, "whoami"]]);
  });
  it("timeout and cli_missing pass through as themselves (row 14)", async () => {
    const { spawnFailed, timedOut } = await import("./fake-runner.js");
    expect(failureOf(await scoped(harness({ repo: timedOut() }), "clients/vela/q3-board"))).toMatchObject({ reason: "timeout" });
    expect(failureOf(await scoped(harness({ repo: spawnFailed("cli_not_found") }), "clients/vela/q3-board"))).toMatchObject({ reason: "cli_missing" });
  });
  it("the host half's scope_outside is bad_scope (row 14)", async () => {
    const { spawnFailed } = await import("./fake-runner.js");
    const h = harness({ repo: spawnFailed("scope_outside") });
    expect(failureOf(await scoped(h, "notes"))).toMatchObject({ code: "invalid_params", reason: "bad_scope" });
  });
  it("an older CLI's real refusal of --within is handler_error in its words, not bad_scope (row 15, recorded on 0.3.22)", async () => {
    const h = harness({ repo: rec("repo.within.0322") });
    expect(failureOf(await scoped(h, "clients/vela/q3-board"))).toEqual({ code: "handler_error", message: "error: unexpected argument '--within' found" });
  });
  it("a scoped syns.repo is one run: the check's run is its answer, without the within key (row 16)", async () => {
    const h = harness({ repo: repoBy({ [SCOPE]: PLACED }) });
    const result = resultOf(await scoped(h, "clients/vela/q3-board"));
    expect(h.runner.calls).toHaveLength(1);
    expect(result).toEqual({ owner: "acme", name: "work", version: ROOT.commitSha, role: "owner", visibility: "private", fileCount: 40, number: 5, holder: "acme/work", path: "clients/vela/q3-board" });
    expect(result).not.toHaveProperty("within");
  });
  it("inside the hold a scoped syns.repo runs repo --json itself, one run (row 16)", async () => {
    const h = harness({ repo: repoBy({ [SCOPE]: PLACED }) });
    await scoped(h, "clients/vela/q3-board");
    await scoped(h, "clients/vela/q3-board");
    expect(h.runner.calls.map((call) => call.args.join(" "))).toEqual(["repo --within=/work/checkout --json", "repo --json"]);
  });
  it("the 404 rule's repo check reuses the check's run in the same call (row 16, S3.5)", async () => {
    const h = harness({ repo: repoBy({ [SCOPE]: PLACED }), cat: rec("not-found-404") });
    expect(failureOf(await scoped(h, "clients/vela/q3-board", "syns.readMany", { paths: ["a.md"] })).code).toBe("not_found");
    expect(h.runner.calls.map((call) => call.args[0])).toEqual(["repo", "cat"]);
  });
  it("unscoped syns.repo is one run, repo --json, as today (row 17, S1.10)", async () => {
    const h = harness({ repo: rec("repo.ok") });
    expect((await h.call("syns.repo")).ok).toBe(true);
    expect(h.runner.calls.map((call) => call.args)).toEqual([["repo", "--json"]]);
  });
  it("edges: a scope starting with a digit, a session path with spaces and non-ASCII, passed verbatim (row 19)", async () => {
    const session = "/Users/Zoë Smith/work spaces/klant ä";
    const scope = `${session}/2026/q3 board`;
    const h = harness({ repo: repoBy({ [scope]: PLACED }) }, { where: { hostId: "host_1", cwd: session } });
    expect((await scoped(h, "2026/q3 board")).ok).toBe(true);
    expect(h.runner.calls[0]).toMatchObject({ cwd: scope, within: session, args: ["repo", `--within=${session}`, "--json"] });
  });
  it("edges: a placed folder of another repository nested in the session's folder answers within false: bad_scope (row 19)", async () => {
    const FOREIGN = { ...ROOT, owner: "other", name: "elsewhere" };
    const h = harness({ repo: repoBy({ "/work/checkout/vendor/other": FOREIGN }, { "/work/checkout/vendor/other": false }) });
    expect(failureOf(await scoped(h, "vendor/other"))).toMatchObject({ code: "invalid_params", reason: "bad_scope" });
    // The check, and nothing else: at the scope, with --within naming the session's folder.
    expect(h.runner.calls.map((call) => [call.cwd, call.within, call.args.join(" ")])).toEqual([["/work/checkout/vendor/other", "/work/checkout", "repo --within=/work/checkout --json"]]);
  });
  it("with no scope, an empty one or null, runs in the session's folder as before, with no check", async () => {
    for (const scope of [undefined, null, ""]) {
      const h = harness({ repo: rec("repo.ok") });
      await scoped(h, scope);
      expect(h.runner.calls.map((call) => call.cwd), String(scope)).toEqual(["/work/checkout"]);
      expect(h.runner.calls[0], String(scope)).not.toHaveProperty("within");
    }
  });
  it("refuses a scope value that is not absent, null or a string, running nothing (fails closed)", async () => {
    for (const scope of [7, true, {}, ["a"]]) {
      const h = harness();
      expect(failureOf(await h.invoke({ method: "syns.repo", params: {}, caller: { sessionId: "thr_page", scope: scope as never }, requestId: "r" })), JSON.stringify(scope)).toMatchObject({ reason: "bad_scope" });
      expect(h.runner.calls).toHaveLength(0);
    }
  });
  it("a trailing slash is dropped", async () => {
    const h = harness({ repo: repoBy({ [SCOPE]: PLACED }) });
    expect((await scoped(h, "clients/vela/q3-board/")).ok).toBe(true);
  });
  it("refuses a scope that leaves the session's folder, though the host refuses it first, running nothing", async () => {
    for (const scope of ["/", "../other", "a/../../b", "/etc", "-x", "a\\b", "a/./b", ".."]) {
      const h = harness();
      expect(failureOf(await scoped(h, scope)), scope).toMatchObject({ code: "invalid_params", reason: "bad_scope" });
      expect(h.runner.calls, scope).toHaveLength(0);
    }
  });
  it("syns.place runs at the session's folder even from a scoped document, with no scope check", async () => {
    const h = harness({ place: rec("place.ok"), status: rec("status.clean") });
    expect((await scoped(h, "clients/vela/q3-board", "syns.place", { template: "acme/whiteboard-template", path: "clients/acme/roadmap" })).ok).toBe(true);
    expect(h.runner.calls.every((call) => call.cwd === "/work/checkout")).toBe(true);
  });
});

describe("syns.place (D43)", () => {
  it("places at the head: status, then place TEMPLATE PATH --json, 2 runs and no --version (row 38)", async () => {
    const h = harness({ place: rec("place.ok"), status: rec("status.clean") });
    expect(resultOf(await h.call("syns.place", { template: "acme/whiteboard-template", path: "clients/vela/q3-board" }))).toEqual({
      path: "clients/vela/q3-board",
      holder: "acme/work",
      template: { repo: "acme/whiteboard-template", version: 13, sha: "8139bace02a82394e491b7b16c39fa6bb2ff4a96" },
      version: "eea167711915077b89d8642312405dbcbcb8baaa",
      number: 2,
      checks: [],
      enableChecks: null,
    });
    expect(h.runner.calls.map((call) => call.args)).toEqual([["status", "--json"], ["place", "--json", "--", "acme/whiteboard-template", "clients/vela/q3-board"]]);
  });
  it("passes --version, and the checks the template recorded with the one command that turns them on", async () => {
    const h = harness({ place: rec("place.checks"), status: rec("status.clean") });
    expect(resultOf(await h.call("syns.place", { template: "acme/checked-template", path: "measure/checked", version: 1 }))).toMatchObject({ checks: ["test -f README.md"], enableChecks: "syns enable-checks measure/checked" });
    expect(h.runner.calls[1]!.args).toEqual(["place", "--version=1", "--json", "--", "acme/checked-template", "measure/checked"]);
  });
  it("refuses as checkout_dirty while the checkout holds unpublished edits, which the CLI's place does not guard, placing nothing (D46)", async () => {
    for (const state of ["status.local", "status.diverged"]) {
      const h = harness({ status: rec(state), place: rec("place.ok") });
      expect(failureOf(await h.call("syns.place", { template: "acme/t", path: "a" })), state).toMatchObject({ code: "conflict", reason: "checkout_dirty" });
      expect(h.runner.calls.some((call) => call.args[0] === "place"), state).toBe(false);
    }
    const unknown = harness({ status: { exitCode: 0, stdout: JSON.stringify({ workingCopyState: "resolution_pending" }), stderr: "", timedOut: false, spawnError: null, overflowed: false }, place: rec("place.ok") });
    expect(failureOf(await unknown.call("syns.place", { template: "acme/t", path: "a" }))).toMatchObject({ reason: "checkout_dirty" }); // an unknown state fails closed
  });
  it("places when the checkout is only behind, with nothing unpublished", async () => {
    expect((await harness({ status: rec("status.behind"), place: rec("place.ok") }).call("syns.place", { template: "acme/t", path: "a" })).ok).toBe(true);
  });
  it("answers occupied and no_such_template from the CLI's refusals", async () => {
    expect(failureOf(await harness({ place: rec("place.occupied"), status: rec("status.clean") }).call("syns.place", { template: "acme/t", path: "a" }))).toMatchObject({ code: "conflict", reason: "occupied" });
    expect(failureOf(await harness({ place: rec("place.no-template"), status: rec("status.clean") }).call("syns.place", { template: "acme/no-such-template", path: "a" }))).toMatchObject({ code: "not_found", reason: "no_such_template" });
  });
  it("refuses a template that is not OWNER/NAME, or a path that leaves the repository, before anything runs", async () => {
    const h = harness();
    for (const params of [{ template: "whiteboard", path: "a" }, { template: "Acme/T", path: "a" }, { template: "acme/t", path: "../a" }, { template: "acme/t", path: "a", version: 0 }]) {
      expect(failureOf(await h.call("syns.place", params)).code, JSON.stringify(params)).toBe("invalid_params");
    }
    expect(h.runner.calls).toHaveLength(0);
  });
});

describe("the host half's scope check (D43, D46)", () => {
  it("passes the session's folder as within on a scoped call", async () => {
    const h = harness({ repo: repoBy({ [SCOPE]: PLACED }) });
    await scoped(h, "clients/vela/q3-board");
    expect(h.runner.calls[0]).toMatchObject({ cwd: SCOPE, within: "/work/checkout" });
  });
  it("scopeFolder(): a placed folder below, a symlink to one, and refusals: unplaced, out, missing, a file, a sibling", async () => {
    const { mkdtemp, mkdir, realpath, symlink, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { scopeFolder } = await import("../src/scope.js");
    const root = await realpath(await mkdtemp(join(tmpdir(), "scope-root-")));
    const outside = await mkdtemp(join(tmpdir(), "scope-out-"));
    await mkdir(join(root, "clients", "vela"), { recursive: true });
    await writeFile(join(root, "clients", "vela", ".syns.yaml"), "holder: acme/work\npath: clients/vela\n");
    await mkdir(join(root, "notes"));
    await writeFile(join(outside, ".syns.yaml"), "owner: other\nname: x\n");
    await symlink(outside, join(root, "escape"));
    await symlink(join(root, "clients"), join(root, "alias"));
    await writeFile(join(root, "file.md"), "x");
    expect(await scopeFolder(join(root, "clients", "vela"), root)).toBe(join(root, "clients", "vela"));
    expect(await scopeFolder(join(root, "alias", "vela"), root)).toBe(join(root, "clients", "vela")); // resolved: the CLI starts there
    expect(await scopeFolder(join(root, "notes"), root)).toBeNull(); // no .syns.yaml of its own
    expect(await scopeFolder(join(root, "escape"), root)).toBeNull();
    expect(await scopeFolder(join(root, "missing"), root)).toBeNull();
    expect(await scopeFolder(join(root, "file.md"), root)).toBeNull();
    expect(await scopeFolder(`${root}-sibling`, root)).toBeNull();
  });
});

describe("syns.place records the page's provenance through the environment (D44)", () => {
  it("sets SYNS_INTEGRATION, SYNS_RUN and SYNS_TRIGGER for place, as the flags other writes carry", async () => {
    const h = harness({ place: rec("place.ok"), status: rec("status.clean") });
    await h.call("syns.place", { template: "acme/whiteboard-template", path: "clients/vela/q3-board" }, "thr_page");
    const placed = h.runner.calls.find((call) => call.args[0] === "place")!;
    expect(placed.env).toEqual({ SYNS_INTEGRATION: "syns-pages", SYNS_RUN: "thr_page", SYNS_TRIGGER: "page" });
    expect(placed.args.some((arg) => arg.startsWith("--integration") || arg.startsWith("--run") || arg.startsWith("--trigger"))).toBe(false);
  });
  it("sets no provenance environment for any other command", async () => {
    const h = harness({ place: rec("place.ok"), status: rec("status.clean"), repo: rec("repo.ok"), write: rec("write.one.ok") });
    await h.call("syns.place", { template: "acme/t", path: "a" });
    await h.call("syns.repo");
    await h.call("syns.write", { path: "a.md", text: "x", base: "7ca9bc78ba047d9e7798b8d2733c254e24cfc837" });
    for (const call of h.runner.calls.filter((c) => c.args[0] !== "place")) expect(call, call.args.join(" ")).not.toHaveProperty("env");
  });
  it("the host contract takes those three keys and no other", async () => {
    const { hostContract } = await import("../src/contract.js");
    const input = (hostContract.run as { input: { safeParse(v: unknown): { success: boolean } } }).input;
    const base = { cwd: "/w", args: ["place"], timeoutMs: 1000 };
    expect(input.safeParse({ ...base, env: { SYNS_INTEGRATION: "syns-pages", SYNS_RUN: "thr_1", SYNS_TRIGGER: "page" } }).success).toBe(true);
    expect(input.safeParse({ ...base, env: { SYNS_INTEGRATION: "a", SYNS_RUN: "b", SYNS_TRIGGER: "c", PATH: "/evil" } }).success).toBe(false);
    expect(input.safeParse({ ...base, env: { LD_PRELOAD: "x" } }).success).toBe(false);
  });
});

describe("a call from an app: an html frame the page bound to a folder (caller.frame, Unife Pages 0.5.4; B-0103, A88)", () => {
  /** A call from a frame the workspace showed with `scope: bound`, now at `scope` (its setScope narrows only). */
  const fromFrame = (h: ReturnType<typeof harness>, bound: unknown, scope: string | null, method = "syns.ls", params: Record<string, unknown> = {}) =>
    h.invoke({ method, params, caller: { sessionId: "thr_page", scope, frame: { scope: bound, title: "board" } } as never, requestId: "r" });

  it("is the call's scope parameter: the CLI runs at the session's folder with the folder as scope, no placed-folder check, its paths counted from it", async () => {
    const h = harness({ ls: rec("ls.ok"), cat: rec("cat.ok") });
    expect((await fromFrame(h, "apps/board", "apps/board")).ok).toBe(true);
    await fromFrame(h, "apps/board", "apps/board", "syns.read", { path: "notes/a.md" });
    expect(h.runner.calls.map((call) => [call.cwd, call.scope, call.args[0]])).toEqual([["/work/checkout", "apps/board", "ls"], ["/work/checkout", "apps/board", "read"]]);
    expect(h.runner.calls[1].args).toEqual(expect.arrayContaining(["apps/board/notes/a.md"]));
  });
  it("reads ../ beyond the folder; a write's ../ and a whole-repository method are bad_scope, running nothing", async () => {
    const h = harness({ cat: rec("cat.ok"), place: rec("place.ok"), status: rec("status.clean") });
    await fromFrame(h, "apps/board", "apps/board", "syns.read", { path: "../shared/theme.css" });
    expect(h.runner.calls.at(-1)).toMatchObject({ cwd: "/work/checkout", scope: "apps/board", args: expect.arrayContaining(["apps/shared/theme.css"]) });
    const runs = h.runner.calls.length;
    expect(failureOf(await fromFrame(h, "apps/board", "apps/board", "syns.write", { path: "../x.md", text: "a", base: "7ca9bc78ba047d9e7798b8d2733c254e24cfc837" }))).toMatchObject({ reason: "bad_scope" });
    for (const method of ["syns.place", "syns.share", "syns.enableChecks", "syns.collaboratorAdd"]) {
      expect(failureOf(await fromFrame(h, "apps/board", "apps/board", method, { template: "acme/whiteboard-template", path: "a", name: "a", user: "u", role: "editor" })), method).toMatchObject({ reason: "bad_scope" });
    }
    expect(h.runner.calls).toHaveLength(runs);
  });
  it("a placed template shown as an app is bounded as an app: syns.place and syns.enableChecks are bad_scope, its ../ reads work (review F2)", async () => {
    const h = harness({ repo: repoBy({ [SCOPE]: PLACED }), cat: rec("cat.ok"), place: rec("place.ok"), status: rec("status.clean") });
    for (const method of ["syns.place", "syns.enableChecks"]) {
      expect(failureOf(await fromFrame(h, "clients/vela/q3-board", "clients/vela/q3-board", method, { template: "acme/whiteboard-template", path: "a" })), method).toMatchObject({ reason: "bad_scope" });
    }
    expect(h.runner.calls).toHaveLength(0);
    await fromFrame(h, "clients/vela/q3-board", "clients/vela/q3-board", "syns.read", { path: "../shared/theme.css" });
    expect(h.runner.calls).toEqual([expect.objectContaining({ cwd: "/work/checkout", scope: "clients/vela/q3-board", args: expect.arrayContaining(["clients/vela/shared/theme.css"]) })]);
  });
  it("a narrower scope the frame set counts from it; a scope parameter counts from the call's scope", async () => {
    const h = harness({ ls: rec("ls.ok") });
    await fromFrame(h, "apps/board", "apps/board/lists");
    await fromFrame(h, "apps/board", "apps/board", "syns.ls", { scope: "lists/2026" });
    expect(h.runner.calls.map((call) => call.scope)).toEqual(["apps/board/lists", "apps/board/lists/2026"]);
  });
  it("a call whose scope is outside its frame's bound, or none under a bound, is bad_scope and runs nothing: the host holds that, and so does this", async () => {
    const h = harness({ ls: rec("ls.ok") });
    for (const scope of [null, "", "apps", "apps/other", "apps/boardroom", "notes"]) expect(failureOf(await fromFrame(h, "apps/board", scope)), String(scope)).toMatchObject({ reason: "bad_scope" });
    expect(h.runner.calls).toHaveLength(0);
  });
  it("a frame mark of another shape fails closed (D46)", async () => {
    const h = harness({ ls: rec("ls.ok") });
    for (const frame of [true, "apps/board", { scope: 3 }, { scope: "/abs" }, { scope: "../up" }]) {
      expect(failureOf(await h.invoke({ method: "syns.ls", params: {}, caller: { sessionId: "thr_page", scope: "apps/board", frame } as never, requestId: "r" })), JSON.stringify(frame)).toMatchObject({ reason: "bad_scope" });
    }
    expect(h.runner.calls).toHaveLength(0);
  });
  it("a frame the page bound to no folder (the agent's own page in the workspace) calls as the page does", async () => {
    const h = harness({ ls: rec("ls.ok"), place: rec("place.ok"), status: rec("status.clean") });
    expect((await fromFrame(h, null, null)).ok).toBe(true);
    expect((await fromFrame(h, null, null, "syns.place", { template: "acme/whiteboard-template", path: "clients/acme/roadmap" })).ok).toBe(true);
    expect(h.runner.calls.every((call) => call.cwd === "/work/checkout" && call.scope === undefined)).toBe(true);
  });
  it("without the frame mark, a plain folder as the document's scope is bad_scope, as before (D43)", async () => {
    const h = harness({ repo: repoBy({}), ls: rec("ls.ok") });
    expect(failureOf(await scoped(h, "apps/board", "syns.ls", {}))).toMatchObject({ reason: "bad_scope" });
  });
});
