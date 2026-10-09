import { describe, expect, it } from "vitest";
import { rec } from "./fake-runner.js";
import { HEAD, OLD, SAMPLES, failureOf, harness, resultOf } from "./harness.js";

const PROVENANCE = ["--integration=syns-pages", "--trigger=page"];
const NEW = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1";

describe("syns.write", () => {
  it("is one CLI process: the parent, the message, the provenance of D6, the path after --, the text on standard input (S1.4, S1.5, S2.12)", async () => {
    const h = harness({ write: rec("write.one.ok") });
    expect(resultOf(await h.call("syns.write", { path: "notes/a.md", text: "# A\n", base: HEAD, message: "Tidy a" }, "thr_abc"))).toEqual({ version: NEW, number: 7 });
    expect(h.runner.calls).toHaveLength(1);
    expect(h.runner.calls[0]!.args).toEqual(["write", `--parent=${HEAD}`, "--message=Tidy a", ...PROVENANCE, "--run=thr_abc", "--json", "--", "notes/a.md"]);
    expect(h.runner.calls[0]!.stdin).toBe("# A\n");
  });
  it("supplies a message naming the operation and the path when the page gives none (S1.6)", async () => {
    const h = harness({ write: rec("write.one.ok"), cat: rec("path-not-found-at-version") });
    await h.call("syns.write", { path: "notes/a.md", text: "", base: HEAD });
    await h.call("syns.write", { path: "notes/new.md", text: "", base: HEAD, create: true });
    expect(h.runner.calls[0]!.args[2]).toBe("--message=Write notes/a.md from a page");
    expect(h.runner.calls[0]!.stdin).toBe("");
    expect(h.runner.calls[2]!.args[2]).toBe("--message=Create notes/new.md from a page");
  });
  it("with create on an existing path is conflict / exists: the path is read at base first, and nothing is written (A25, S1.19)", async () => {
    const h = harness({ cat: rec("cat.ok") });
    expect(failureOf(await h.call("syns.write", { path: "README.md", text: "mine", base: HEAD, create: true }))).toMatchObject({ code: "conflict", reason: "exists" });
    expect(h.runner.calls.map((call) => call.args)).toEqual([["cat", `--version=${HEAD}`, "--json", "--", "README.md"]]);
    expect(h.log[0]).toContain("outcome=exists");
  });
  it("with create on a path that is not there at base, writes against the same base (S1.19)", async () => {
    const h = harness({ cat: rec("path-not-found-at-version"), write: rec("write.one.ok") });
    expect(resultOf(await h.call("syns.write", { path: "notes/new.md", text: "new", base: HEAD, create: true }))).toEqual({ version: NEW, number: 7 });
    expect(h.runner.calls.map((call) => call.args.slice(0, 2))).toEqual([["cat", `--version=${HEAD}`], ["write", `--parent=${HEAD}`]]);
    expect(h.runner.calls[1]!.stdin).toBe("new");
  });
  it("with create and a head that has moved, the write is refused as stale_head: nothing slips between the check and the write (S1.19)", async () => {
    const h = harness({ cat: rec("path-not-found-at-version"), write: rec("stale-parent") });
    expect(failureOf(await h.call("syns.write", { path: "notes/new.md", text: "new", base: OLD, create: true }))).toMatchObject({ code: "conflict", reason: "stale_head", detail: { current: HEAD } });
  });
  it("with create and a base that is no version, answers not_found and writes nothing", async () => {
    const h = harness({ cat: rec("version-not-found") });
    expect(failureOf(await h.call("syns.write", { path: "notes/new.md", text: "new", base: OLD, create: true })).code).toBe("not_found");
    expect(h.runner.calls).toHaveLength(1);
  });
  it("without create runs no read", async () => {
    const h = harness({ write: rec("write.one.ok") });
    await h.call("syns.write", { path: "README.md", text: "x", base: HEAD, create: false });
    expect(h.runner.calls.map((call) => call.args[0])).toEqual(["write"]);
  });
  it("a stale base is stale_head, a dirty checkout checkout_dirty (A3, A29)", async () => {
    expect(failureOf(await harness({ write: rec("stale-parent") }).call("syns.write", { path: "a.md", text: "x", base: OLD }))).toMatchObject({ code: "conflict", reason: "stale_head", detail: { current: HEAD } });
    expect(failureOf(await harness({ write: rec("checkout-dirty") }).call("syns.write", { path: "a.md", text: "x", base: HEAD }))).toMatchObject({ code: "conflict", reason: "checkout_dirty" });
  });
  it("a text and a message beginning with -- are stored as text and change no flag (A32)", async () => {
    const h = harness({ write: rec("write.one.ok") });
    await h.call("syns.write", { path: "a.md", text: "--parent=1\n--json", base: HEAD, message: "--repo=someone/else" });
    expect(h.runner.calls[0]!.args).toEqual(["write", `--parent=${HEAD}`, "--message=--repo=someone/else", ...PROVENANCE, "--run=thr_page", "--json", "--", "a.md"]);
    expect(h.runner.calls[0]!.stdin).toBe("--parent=1\n--json");
  });
  it("logs the method, the session, one path and the outcome, never the text or the message (S2.19, S2.20)", async () => {
    const h = harness({ write: rec("write.one.ok") });
    await h.call("syns.write", { path: "a.md", text: "PRIVATE TEXT", base: HEAD, message: "PRIVATE MESSAGE" }, "thr_abc");
    expect(h.log).toHaveLength(1);
    expect(h.log[0]).toContain("syns.write session=thr_abc paths=1 outcome=ok");
    expect(h.log[0]).not.toContain("PRIVATE");
  });
});

describe("syns.edit", () => {
  it("passes old and new as option values, with the parent, the message and the provenance (S2.11, S2.12)", async () => {
    const h = harness({ edit: rec("write.one.ok") });
    expect(resultOf(await h.call("syns.edit", { path: "notes/a.md", old: "colour", new: "color", base: HEAD }, "thr_abc"))).toEqual({ version: NEW, number: 7, changed: 1 });
    expect(h.runner.calls.map((call) => call.args)).toEqual([["edit", "--old=colour", "--new=color", `--parent=${HEAD}`, "--message=Edit notes/a.md from a page", ...PROVENANCE, "--run=thr_abc", "--json", "--", "notes/a.md"]]);
    expect(h.runner.calls[0]!.stdin).toBeUndefined();
  });
  it("passes replaceAll as --replace-all, and an empty new as an empty value", async () => {
    const h = harness({ edit: rec("write.one.ok") });
    await h.call("syns.edit", { path: "a.md", old: "x", new: "", replaceAll: true, base: HEAD, message: "m" });
    expect(h.runner.calls[0]!.args.slice(0, 4)).toEqual(["edit", "--old=x", "--new=", "--replace-all"]);
  });
  it("an old or a new beginning with -- stays inside its own argument and changes no flag (A32)", async () => {
    const h = harness({ edit: rec("write.one.ok") });
    await h.call("syns.edit", { path: "a.md", old: "--replace-all", new: "--parent=1\n--json", base: HEAD, message: "m" });
    expect(h.runner.calls[0]!.args).toEqual(["edit", "--old=--replace-all", "--new=--parent=1\n--json", `--parent=${HEAD}`, "--message=m", ...PROVENANCE, "--run=thr_page", "--json", "--", "a.md"]);
  });
  it("no match is invalid_params / no_match (A26)", async () => {
    const h = harness({ edit: rec("edit-no-match") });
    expect(failureOf(await h.call("syns.edit", { path: "a.md", old: "absent", new: "x", base: HEAD }))).toMatchObject({ code: "invalid_params", reason: "no_match" });
  });
  it("several matches without replaceAll is invalid_params / many_matches with the count (A26)", async () => {
    const h = harness({ edit: rec("edit-many-matches") });
    const error = failureOf(await h.call("syns.edit", { path: "a.md", old: "e", new: "x", base: HEAD }));
    expect(error).toMatchObject({ code: "invalid_params", reason: "many_matches", detail: { count: 33 } });
    expect(error.message).not.toContain("--replace-all");
  });
  it("bounds old to 1–32,768 characters and new to 32,768, and refuses a NUL, which no argument can carry", async () => {
    const h = harness({ edit: rec("write.one.ok") });
    const at = { path: "a.md", base: HEAD };
    for (const params of [{ old: "", new: "x" }, { old: "x".repeat(32769), new: "x" }, { old: "x", new: "x".repeat(32769) }, { old: "a\u0000b", new: "x" }, { old: "x", new: "a\u0000b" }, { old: "x" }, { new: "x" }]) {
      expect(failureOf(await h.call("syns.edit", { ...at, ...params })).code).toBe("invalid_params");
    }
    expect(h.runner.calls).toHaveLength(0);
    expect((await h.call("syns.edit", { ...at, old: "x".repeat(32768), new: "line one\nline two\n".repeat(1820) })).ok).toBe(true);
  });
  it("logs neither text (S2.20)", async () => {
    const h = harness({ edit: rec("write.one.ok") });
    await h.call("syns.edit", { path: "a.md", old: "PRIVATE OLD", new: "PRIVATE NEW", base: HEAD });
    expect(h.log.join("\n")).toContain("syns.edit");
    expect(h.log.join("\n")).not.toContain("PRIVATE");
  });
});

describe("syns.rm", () => {
  it("removes one path against base, with the provenance, and says how many paths changed", async () => {
    const h = harness({ rm: rec("write.one.ok") });
    expect(resultOf(await h.call("syns.rm", { path: "notes/old.md", base: HEAD }, "thr_abc"))).toEqual({ version: NEW, number: 7, changed: 1 });
    expect(h.runner.calls.map((call) => call.args)).toEqual([["rm", `--parent=${HEAD}`, "--message=Remove notes/old.md from a page", ...PROVENANCE, "--run=thr_abc", "--json", "--", "notes/old.md"]]);
  });
  it("a missing path mirrors the CLI: success, the unchanged version and changed 0 (A27, D15)", async () => {
    const h = harness({ rm: rec("write.unchanged") });
    expect(resultOf(await h.call("syns.rm", { path: "gone.md", base: HEAD }))).toEqual({ version: HEAD, number: 6, changed: 0 });
    expect(h.runner.calls).toHaveLength(1);
  });
  it("a stale base is stale_head", async () => {
    const h = harness({ rm: rec("stale-parent") });
    expect(failureOf(await h.call("syns.rm", { path: "a.md", base: OLD }))).toMatchObject({ code: "conflict", reason: "stale_head" });
  });
});

describe("syns.revert", () => {
  it("calls the CLI's revert as it is: --to, the path after --, no parent and no provenance (A28, D13)", async () => {
    const h = harness({ revert: rec("write.one.ok") });
    expect(resultOf(await h.call("syns.revert", { path: "notes/a.md", to: OLD }, "thr_abc"))).toEqual({ version: NEW, number: 7 });
    expect(h.runner.calls.map((call) => call.args)).toEqual([["revert", `--to=${OLD}`, "--json", "--", "notes/a.md"]]);
  });
  it("passes a message when the page gives one", async () => {
    const h = harness({ revert: rec("write.one.ok") });
    await h.call("syns.revert", { path: "a.md", to: OLD, message: "--parent=1" });
    expect(h.runner.calls[0]!.args).toEqual(["revert", `--to=${OLD}`, "--message=--parent=1", "--json", "--", "a.md"]);
  });
  it("takes no base, and no provenance (D13, S1.5)", async () => {
    const h = harness();
    for (const key of ["base", "integration", "trigger", "run"]) expect(failureOf(await h.call("syns.revert", { path: "a.md", to: OLD, [key]: HEAD })).code, key).toBe("invalid_params");
    expect(failureOf(await h.call("syns.revert", { path: "a.md" })).code).toBe("invalid_params");
    expect(failureOf(await h.call("syns.revert", { path: "a.md", to: "4" })).code).toBe("invalid_params");
    expect(h.runner.calls).toHaveLength(0);
  });
  it("a path or a version that is not there is not_found", async () => {
    expect(failureOf(await harness({ revert: rec("not-found-404"), repo: rec("repo.ok") }).call("syns.revert", { path: "nope.md", to: OLD })).code).toBe("not_found");
    expect(failureOf(await harness({ revert: rec("version-not-found") }).call("syns.revert", { path: "a.md", to: OLD })).code).toBe("not_found");
  });
  it("a dirty checkout is checkout_dirty, and the write is logged", async () => {
    const h = harness({ revert: rec("checkout-dirty") });
    expect(failureOf(await h.call("syns.revert", { path: "a.md", to: OLD }))).toMatchObject({ code: "conflict", reason: "checkout_dirty" });
    expect(h.log[0]).toContain("syns.revert session=thr_page paths=1 outcome=checkout_dirty");
  });
});

describe("no write but syns.revert is accepted without base (A30)", () => {
  const calls: [string, Record<string, unknown>][] = [
    ["syns.write", { path: "a.md", text: "x" }],
    ["syns.write", { path: "a.md", text: "x", base: "6" }],
    ["syns.edit", { path: "a.md", old: "x", new: "y" }],
    ["syns.rm", { path: "a.md" }],
    ["syns.rm", { path: "a.md", base: "--parent=1" }],
  ];
  for (const [method, params] of calls) {
    it(`${method} ${JSON.stringify(params)}`, async () => {
      const h = harness();
      expect(failureOf(await h.call(method, params)).code).toBe("invalid_params");
      expect(h.runner.calls).toHaveLength(0);
    });
  }
});

describe("a page can set none of a write's provenance (S1.5)", () => {
  const calls: [string, Record<string, unknown>][] = [
    ["syns.write", { path: "a.md", text: "x", base: HEAD }],
    ["syns.edit", { path: "a.md", old: "x", new: "y", base: HEAD }],
    ["syns.rm", { path: "a.md", base: HEAD }],
  ];
  for (const [method, params] of calls) {
    it(method, async () => {
      const h = harness();
      for (const key of ["integration", "trigger", "run", "taskRef"]) expect(failureOf(await h.call(method, { ...params, [key]: "x" })).code, key).toBe("invalid_params");
      expect(failureOf(await h.call(method, { ...params, message: "m".repeat(501) })).code).toBe("invalid_params");
    });
  }
});

describe("every page write carries the page's mark, which no other publisher sets (D6, Syns issue 214)", () => {
  // Pages tell their own writes by integration and trigger together: run alone is set by agents' pushes too.
  for (const method of ["syns.write", "syns.edit", "syns.rm", "syns.commit", "syns.writeBinary"]) {
    it(method, async () => {
      const h = harness();
      await h.call(method, SAMPLES[method], "thr_page");
      const published = h.runner.calls.filter((call) => call.args.includes("--integration=syns-pages"));
      expect(published, method).toHaveLength(1);
      expect(published[0]!.args).toEqual(expect.arrayContaining(["--integration=syns-pages", "--trigger=page", "--run=thr_page"]));
    });
  }
});
