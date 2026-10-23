import { describe, expect, it } from "vitest";
import { buildDeclaration } from "../src/declaration.js";
import { METHODS } from "../src/methods/index.js";
import { ok, rec } from "./fake-runner.js";
import { HEAD, OLD, failureOf, harness, resultOf } from "./harness.js";

/** syns.move and syns.copy (Syns B-0062, roadmap/228): `syns mv` and `syns cp` as they are, one run, one version. */
const PROVENANCE = ["--integration=syns-pages", "--trigger=page"];
const APP = "apps/todo";

describe("syns.move and syns.copy", () => {
  it("syns.move is one run of syns mv: the parent, a message naming both paths, the page's provenance, the paths after --; the CLI's member answered (row 1)", async () => {
    const h = harness({ mv: rec("mv.dir.0325") });
    expect(resultOf(await h.call("syns.move", { from: "q3-plan", to: "q3-review", base: HEAD }, "thr_abc"))).toEqual({ version: "772c50d851f908c31d61547fc59f7e7c2e59c6df", number: 2, from: "q3-plan", to: "q3-review", files: 3 });
    expect(h.runner.calls.map((call) => call.args)).toEqual([["mv", `--parent=${HEAD}`, "--message=Move q3-plan to q3-review from a page", ...PROVENANCE, "--run=thr_abc", "--json", "--", "q3-plan", "q3-review"]]);
    expect(h.runner.calls[0]!.stdin).toBeUndefined();
  });
  it("a file's move answers one file", async () => {
    const h = harness({ mv: rec("mv.file.0325") });
    expect(resultOf(await h.call("syns.move", { from: "a.md", to: "c.md", base: HEAD, message: "Rename" }))).toEqual({ version: "89ac9e8a0c68969b4419f7fcad6a3c5c3fd6cc88", number: 3, from: "a.md", to: "c.md", files: 1 });
    expect(h.runner.calls[0]!.args[2]).toBe("--message=Rename");
  });
  it("syns.copy is one run of syns cp, its copies member answered (row 2)", async () => {
    const h = harness({ cp: rec("cp.dir.0325") });
    expect(resultOf(await h.call("syns.copy", { from: "q3-review", to: "q3-copy", base: HEAD }))).toEqual({ version: "8de074b37f3cfd27470a0bce411378b3eb964c1d", number: 4, from: "q3-review", to: "q3-copy", files: 3 });
    expect(h.runner.calls[0]!.args.slice(0, 3)).toEqual(["cp", `--parent=${HEAD}`, "--message=Copy q3-review to q3-copy from a page"]);
  });
  it("a moved head is stale_head naming it (row 3)", async () => {
    const h = harness({ mv: rec("mv.stale.0325") });
    expect(failureOf(await h.call("syns.move", { from: "b.md", to: "d.md", base: OLD }))).toMatchObject({ code: "conflict", reason: "stale_head", detail: { current: "8de074b37f3cfd27470a0bce411378b3eb964c1d" } });
  });
  it("a destination standing at base is exists, for a move and a copy (row 4)", async () => {
    expect(failureOf(await harness({ mv: rec("mv.path-exists.0325") }).call("syns.move", { from: "b.md", to: "c.md", base: HEAD }))).toMatchObject({ code: "conflict", reason: "exists" });
    expect(failureOf(await harness({ cp: rec("mv.path-exists.0325") }).call("syns.copy", { from: "b.md", to: "c.md", base: HEAD }))).toMatchObject({ code: "conflict", reason: "exists" });
  });
  it("only a method declaring exists maps the CLI's path_exists line to it", async () => {
    const answer = failureOf(await harness({ rm: rec("mv.path-exists.0325") }).call("syns.rm", { path: "c.md", base: HEAD }));
    expect(answer.code).toBe("handler_error");
    expect(answer.reason).toBeUndefined();
  });
  it("a source missing at base is not_found (row 5)", async () => {
    const h = harness({ cp: rec("cp.not-found.0325") });
    const answer = failureOf(await h.call("syns.copy", { from: "nowhere", to: "x", base: HEAD }));
    expect(answer.code).toBe("not_found");
    expect(h.runner.calls).toHaveLength(1);
  });
  it("unpublished work in the session's folder is checkout_dirty (row 6)", async () => {
    expect(failureOf(await harness({ mv: rec("checkout-dirty") }).call("syns.move", { from: "a.md", to: "b.md", base: HEAD }))).toMatchObject({ code: "conflict", reason: "checkout_dirty" });
  });
  it("a destination under the source comes back in the CLI's own words (D59): the plugin adds no check", async () => {
    const answer = failureOf(await harness({ mv: rec("mv.under.0325") }).call("syns.move", { from: "q3-review", to: "q3-review/x", base: HEAD }));
    expect(answer).toMatchObject({ code: "handler_error", message: "configuration error: cannot move q3-review to q3-review/x: q3-review/x lies under q3-review" });
  });
  it("under a scope both paths count from the folder and the answer is cut back (row 7)", async () => {
    const h = harness({ mv: ok({ commitSha: HEAD, version: 9, created: false, filesChanged: 1, moves: [{ files: 1, from: `${APP}/a.json`, to: `${APP}/old/a.json`, type: "file" }] }) });
    expect(resultOf(await h.call("syns.move", { from: "a.json", to: "old/a.json", base: HEAD, scope: APP }))).toEqual({ version: HEAD, number: 9, from: "a.json", to: "old/a.json", files: 1 });
    expect(h.runner.calls[0]).toMatchObject({ scope: APP });
    expect(h.runner.calls[0]!.args.slice(-3)).toEqual(["--", `${APP}/a.json`, `${APP}/old/a.json`]);
  });
  it("a path leaving the scope is bad_scope, and nothing runs (row 8)", async () => {
    for (const params of [{ from: "../x.md", to: "a.md" }, { from: "a.md", to: "../x.md" }]) {
      const h = harness({ mv: rec("mv.file.0325"), cp: rec("cp.dir.0325") });
      expect(failureOf(await h.call("syns.move", { ...params, base: HEAD, scope: APP })).reason).toBe("bad_scope");
      expect(failureOf(await h.call("syns.copy", { ...params, base: HEAD, scope: APP })).reason).toBe("bad_scope");
      expect(h.runner.calls).toHaveLength(0);
    }
  });
  it("refuses an empty path, a . or .. segment and a missing base before any run", async () => {
    const h = harness({ mv: rec("mv.file.0325") });
    for (const params of [{ from: "", to: "b.md", base: HEAD }, { from: ".", to: "b.md", base: HEAD }, { from: "a.md", to: "x/..", base: HEAD }, { from: "a.md", to: "b.md" }]) {
      expect(failureOf(await h.call("syns.move", params)).code, JSON.stringify(params)).toBe("invalid_params");
    }
    expect(h.runner.calls).toHaveLength(0);
  });
  it("are declared as writes with stale_head, checkout_dirty and exists, and share one guide line (row 9)", () => {
    const declaration = buildDeclaration(METHODS, { agentInstructions: true });
    for (const name of ["syns.move", "syns.copy"]) {
      const method = declaration.methods.find((entry) => entry.name === name)!;
      expect(method.effect, name).toBe("contributed-write");
      for (const reason of ["stale_head", "checkout_dirty", "exists"]) expect(Object.keys(method.reasons), name).toContain(reason);
    }
    expect(declaration.guide).toContain("- `syns.move` / `syns.copy` `{ from: path, to: path, base, message? }` → `{ version, number, from: string, to: string, files: int }`");
  });
  it("the log names the method, the session, two paths and the outcome, never the message", async () => {
    const h = harness({ mv: rec("mv.file.0325") });
    await h.call("syns.move", { from: "a.md", to: "c.md", base: HEAD, message: "PRIVATE MESSAGE" }, "thr_abc");
    expect(h.log[0]).toContain("syns.move session=thr_abc paths=2 outcome=ok");
    expect(h.log[0]).not.toContain("PRIVATE");
  });
});
