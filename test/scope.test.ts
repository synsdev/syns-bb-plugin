import { describe, expect, it } from "vitest";
import { rec } from "./fake-runner.js";
import { failureOf, harness, resultOf } from "./harness.js";

/** A call from a document that set a scope (D43). The host's exact field may still change. */
const scoped = (h: ReturnType<typeof harness>, scope: string | null | undefined, method = "syns.repo", params: unknown = {}) =>
  h.invoke({ method, params, caller: { sessionId: "thr_page", scope }, requestId: "r" });

/** `repo --json` at the session's root (acme/work) and in a folder placed in it, or in another repository. */
const ROOT = { owner: "acme", name: "work", commitSha: "7ca9bc78ba047d9e7798b8d2733c254e24cfc837", version: 5, role: "owner", visibility: "private", fileCount: 40 };
const PLACED = { ...ROOT, holder: "acme/work", path: "clients/vela/q3-board" };
const FOREIGN = { ...ROOT, owner: "other", name: "elsewhere" };
const repoBy = (byCwd: Record<string, unknown>) => (request: { cwd: string }) => {
  const doc = byCwd[request.cwd];
  return doc === undefined ? rec("no-identity") : { exitCode: 0, stdout: JSON.stringify(doc), stderr: "", timedOut: false, spawnError: null, overflowed: false };
};

describe("a document's scope (D43, D46)", () => {
  it("runs the CLI in <session folder>/<scope>, after checking the scope is a folder of the session's repository", async () => {
    const h = harness({ repo: repoBy({ "/work/checkout": ROOT, "/work/checkout/clients/vela/q3-board": PLACED }) });
    const answer = await scoped(h, "clients/vela/q3-board");
    expect(answer.ok).toBe(true);
    expect(h.runner.calls.map((call) => [call.cwd, call.args.join(" ")])).toEqual([
      ["/work/checkout", "repo --json"],
      ["/work/checkout/clients/vela/q3-board", "repo --json"],
      ["/work/checkout/clients/vela/q3-board", "repo --json"],
    ]);
  });
  it("holds a confirmed scope for a minute: the next call runs only its own command", async () => {
    const h = harness({ repo: repoBy({ "/work/checkout": ROOT, "/work/checkout/clients/vela/q3-board": PLACED }) });
    await scoped(h, "clients/vela/q3-board");
    await scoped(h, "clients/vela/q3-board");
    expect(h.runner.calls).toHaveLength(4);
  });
  it("refuses a scope that is another repository's checkout, nested in the session's folder", async () => {
    const h = harness({ repo: repoBy({ "/work/checkout": ROOT, "/work/checkout/vendor/other": FOREIGN }) });
    expect(failureOf(await scoped(h, "vendor/other"))).toMatchObject({ code: "invalid_params", reason: "bad_scope" });
    expect(h.runner.calls.filter((call) => call.cwd === "/work/checkout/vendor/other")).toHaveLength(1); // the check, and nothing else
  });
  it("refuses every scope when the session's folder is no Syns repository", async () => {
    const h = harness({ repo: repoBy({ "/work/checkout/clients/vela/q3-board": PLACED }) });
    expect(failureOf(await scoped(h, "clients/vela/q3-board"))).toMatchObject({ reason: "bad_scope" });
  });
  it("refuses a scope the host half finds outside, unplaced (no .syns.yaml of its own) or missing", async () => {
    const { spawnFailed } = await import("./fake-runner.js");
    const h = harness({ repo: (request: { cwd: string }) => (request.cwd === "/work/checkout" ? { exitCode: 0, stdout: JSON.stringify(ROOT), stderr: "", timedOut: false, spawnError: null, overflowed: false } : spawnFailed("scope_outside")) });
    expect(failureOf(await scoped(h, "notes"))).toMatchObject({ code: "invalid_params", reason: "bad_scope" });
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
    const h = harness({ repo: repoBy({ "/work/checkout": ROOT, "/work/checkout/clients/vela/q3-board": PLACED }) });
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
  it("places at the head: place TEMPLATE PATH --json, after a version check for 0.3.6", async () => {
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
    expect(h.runner.calls.map((call) => call.args)).toEqual([["--version"], ["status", "--json"], ["place", "--json", "--", "acme/whiteboard-template", "clients/vela/q3-board"]]);
  });
  it("passes --version, and the checks the template recorded with the one command that turns them on", async () => {
    const h = harness({ place: rec("place.checks"), status: rec("status.clean") });
    expect(resultOf(await h.call("syns.place", { template: "acme/checked-template", path: "measure/checked", version: 1 }))).toMatchObject({ checks: ["test -f README.md"], enableChecks: "syns enable-checks measure/checked" });
    expect(h.runner.calls[2]!.args).toEqual(["place", "--version=1", "--json", "--", "acme/checked-template", "measure/checked"]);
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
  it("answers cli_too_old before 0.3.6, which has no place", async () => {
    const h = harness({ "--version": { exitCode: 0, stdout: "syns 0.3.5\n", stderr: "", timedOut: false, spawnError: null, overflowed: false } });
    expect(failureOf(await h.call("syns.place", { template: "acme/t", path: "a" }))).toMatchObject({ reason: "cli_too_old", detail: { need: "0.3.6", have: "0.3.5" } });
  });
});

describe("the host half's scope check (D43, D46)", () => {
  it("passes the session's folder as within on a scoped call", async () => {
    const h = harness({ repo: repoBy({ "/work/checkout": ROOT, "/work/checkout/clients/vela/q3-board": PLACED }) });
    await scoped(h, "clients/vela/q3-board");
    expect(h.runner.calls[1]).toMatchObject({ cwd: "/work/checkout/clients/vela/q3-board", within: "/work/checkout" });
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
    expect(placed.env).toEqual({ SYNS_INTEGRATION: "syns-bb-plugin", SYNS_RUN: "thr_page", SYNS_TRIGGER: "thread-page" });
    expect(placed.args.some((arg) => arg.startsWith("--integration") || arg.startsWith("--run") || arg.startsWith("--trigger"))).toBe(false);
  });
  it("sets no environment for any other command, nor for the version check", async () => {
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
    expect(input.safeParse({ ...base, env: { SYNS_INTEGRATION: "syns-bb-plugin", SYNS_RUN: "thr_1", SYNS_TRIGGER: "thread-page" } }).success).toBe(true);
    expect(input.safeParse({ ...base, env: { SYNS_INTEGRATION: "a", SYNS_RUN: "b", SYNS_TRIGGER: "c", PATH: "/evil" } }).success).toBe(false);
    expect(input.safeParse({ ...base, env: { LD_PRELOAD: "x" } }).success).toBe(false);
  });
});
