import { describe, expect, it } from "vitest";
import { rec } from "./fake-runner.js";
import { failureOf, harness, resultOf } from "./harness.js";

/** A call from a document that set a scope (D43). The host's exact field may still change. */
const scoped = (h: ReturnType<typeof harness>, scope: string | null | undefined, method = "syns.repo", params: unknown = {}) =>
  h.invoke({ method, params, caller: { sessionId: "thr_page", scope }, requestId: "r" });

describe("a document's scope (D43)", () => {
  it("runs the CLI in <session folder>/<scope>", async () => {
    const h = harness({ repo: rec("repo.folder") });
    expect((await scoped(h, "clients/vela/q3-board")).ok).toBe(true);
    expect(h.runner.calls[0]!.cwd).toBe("/work/checkout/clients/vela/q3-board");
  });
  it("with no scope, an empty one or null, runs in the session's folder as before", async () => {
    for (const scope of [undefined, null, "", "/"]) {
      const h = harness({ repo: rec("repo.ok") });
      if (scope === "/") {
        expect(failureOf(await scoped(h, scope))).toMatchObject({ code: "invalid_params", reason: "bad_scope" });
        continue;
      }
      await scoped(h, scope);
      expect(h.runner.calls[0]!.cwd, String(scope)).toBe("/work/checkout");
    }
  });
  it("a trailing slash is dropped", async () => {
    const h = harness({ repo: rec("repo.folder") });
    await scoped(h, "clients/vela/");
    expect(h.runner.calls[0]!.cwd).toBe("/work/checkout/clients/vela");
  });
  it("refuses a scope that leaves the session's folder, though the host refuses it first, running nothing", async () => {
    for (const scope of ["../other", "a/../../b", "/etc", "-x", "a\\b", "a/./b", ".."]) {
      const h = harness();
      expect(failureOf(await scoped(h, scope)), scope).toMatchObject({ code: "invalid_params", reason: "bad_scope" });
      expect(h.runner.calls, scope).toHaveLength(0);
    }
  });
  it("syns.place runs at the session's folder even from a scoped document", async () => {
    const h = harness({ place: rec("place.ok") });
    expect((await scoped(h, "clients/vela/q3-board", "syns.place", { template: "acme/whiteboard-template", path: "clients/acme/roadmap" })).ok).toBe(true);
    expect(h.runner.calls.every((call) => call.cwd === "/work/checkout")).toBe(true);
  });
});

describe("syns.place (D43)", () => {
  it("places at the head: place TEMPLATE PATH --json, after a version check for 0.3.6", async () => {
    const h = harness({ place: rec("place.ok") });
    expect(resultOf(await h.call("syns.place", { template: "acme/whiteboard-template", path: "clients/vela/q3-board" }))).toEqual({
      path: "clients/vela/q3-board",
      holder: "acme/work",
      template: { repo: "acme/whiteboard-template", version: 13, sha: "8139bace02a82394e491b7b16c39fa6bb2ff4a96" },
      version: "eea167711915077b89d8642312405dbcbcb8baaa",
      number: 2,
      checks: [],
      enableChecks: null,
    });
    expect(h.runner.calls.map((call) => call.args)).toEqual([["--version"], ["place", "--json", "--", "acme/whiteboard-template", "clients/vela/q3-board"]]);
  });
  it("passes --version, and the checks the template recorded with the one command that turns them on", async () => {
    const h = harness({ place: rec("place.checks") });
    expect(resultOf(await h.call("syns.place", { template: "acme/checked-template", path: "measure/checked", version: 1 }))).toMatchObject({ checks: ["test -f README.md"], enableChecks: "syns enable-checks measure/checked" });
    expect(h.runner.calls[1]!.args).toEqual(["place", "--version=1", "--json", "--", "acme/checked-template", "measure/checked"]);
  });
  it("answers occupied and no_such_template from the CLI's refusals", async () => {
    expect(failureOf(await harness({ place: rec("place.occupied") }).call("syns.place", { template: "acme/t", path: "a" }))).toMatchObject({ code: "conflict", reason: "occupied" });
    expect(failureOf(await harness({ place: rec("place.no-template") }).call("syns.place", { template: "acme/no-such-template", path: "a" }))).toMatchObject({ code: "not_found", reason: "no_such_template" });
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

describe("symlinks: the host half resolves a scope before it runs anything (D43)", () => {
  it("passes the session's folder as within on a scoped call, and nothing on an unscoped one", async () => {
    const h = harness({ repo: rec("repo.folder") });
    await scoped(h, "clients/vela");
    expect(h.runner.calls[0]).toMatchObject({ cwd: "/work/checkout/clients/vela", within: "/work/checkout" });
    const plain = harness({ repo: rec("repo.ok") });
    await scoped(plain, undefined);
    expect(plain.runner.calls[0]).not.toHaveProperty("within");
  });
  it("answers bad_scope when the host half finds the scope outside, or no folder", async () => {
    const { spawnFailed } = await import("./fake-runner.js");
    const h = harness({ repo: spawnFailed("scope_outside") });
    expect(failureOf(await scoped(h, "linked"))).toMatchObject({ code: "invalid_params", reason: "bad_scope" });
  });
  it("inside(): a folder below, the folder itself, a symlink out, a missing folder, a file", async () => {
    const { mkdtemp, mkdir, symlink, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { inside } = await import("../src/scope.js");
    const root = await mkdtemp(join(tmpdir(), "scope-root-"));
    const outside = await mkdtemp(join(tmpdir(), "scope-out-"));
    await mkdir(join(root, "clients", "vela"), { recursive: true });
    await symlink(outside, join(root, "escape"));
    await symlink(join(root, "clients"), join(root, "alias"));
    await writeFile(join(root, "file.md"), "x");
    expect(await inside(join(root, "clients", "vela"), root)).toBe(true);
    expect(await inside(root, root)).toBe(true);
    expect(await inside(join(root, "alias", "vela"), root)).toBe(true);
    expect(await inside(join(root, "escape"), root)).toBe(false);
    expect(await inside(join(root, "missing"), root)).toBe(false);
    expect(await inside(join(root, "file.md"), root)).toBe(false);
    expect(await inside(`${root}-sibling`, root)).toBe(false);
  });
});

describe("syns.place records the page's provenance through the environment (D44)", () => {
  it("sets SYNS_INTEGRATION, SYNS_RUN and SYNS_TRIGGER for place, as the flags other writes carry", async () => {
    const h = harness({ place: rec("place.ok") });
    await h.call("syns.place", { template: "acme/whiteboard-template", path: "clients/vela/q3-board" }, "thr_page");
    const placed = h.runner.calls.find((call) => call.args[0] === "place")!;
    expect(placed.env).toEqual({ SYNS_INTEGRATION: "syns-bb-plugin", SYNS_RUN: "thr_page", SYNS_TRIGGER: "thread-page" });
    expect(placed.args.some((arg) => arg.startsWith("--integration") || arg.startsWith("--run") || arg.startsWith("--trigger"))).toBe(false);
  });
  it("sets no environment for any other command, nor for the version check", async () => {
    const h = harness({ place: rec("place.ok"), repo: rec("repo.ok"), write: rec("write.one.ok") });
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
