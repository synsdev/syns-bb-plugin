import { describe, expect, it } from "vitest";
import { rec } from "./fake-runner.js";
import { HEAD, OLD, failureOf, harness, resultOf } from "./harness.js";

const PROVENANCE = ["--integration=syns-bb-plugin", "--trigger=thread-page"];

describe("syns.commit", () => {
  it("is one CLI process: the parent, the message, the provenance of D6, and the changeset on standard input (S1.4, S1.5, S2.12)", async () => {
    const h = harness({ commit: rec("write.ok") });
    const answer = await h.call("syns.commit", { base: HEAD, message: "Tidy notes", files: [{ path: "notes/a.md", text: "A" }, { path: "notes/b.md", text: "B" }], deletions: ["notes/old.md"] }, "thr_abc");
    expect(resultOf(answer)).toEqual({ version: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1", number: 7, changed: 3 });
    expect(h.runner.calls).toHaveLength(1);
    expect(h.runner.calls[0]!.args).toEqual(["commit", `--parent=${HEAD}`, "--message=Tidy notes", ...PROVENANCE, "--run=thr_abc", "--json"]);
    expect(JSON.parse(h.runner.calls[0]!.stdin!)).toEqual({ files: [{ path: "notes/a.md", content: "A" }, { path: "notes/b.md", content: "B" }], deletions: [{ path: "notes/old.md" }] });
  });

  it("supplies a message naming the operation and the path when the page gives none (S1.6)", async () => {
    const h = harness({ commit: rec("write.ok") });
    await h.call("syns.commit", { base: HEAD, files: [{ path: "notes/a.md", text: "A" }] });
    await h.call("syns.commit", { base: HEAD, files: [{ path: "notes/a.md", text: "A" }], deletions: ["b.md", "c.md"] });
    expect(h.runner.calls[0]!.args[2]).toBe("--message=Commit notes/a.md from a page");
    expect(h.runner.calls[1]!.args[2]).toBe("--message=Commit 3 paths from a page");
  });

  it("a stale base is conflict / stale_head with the current version as detail, and nothing is tried again (A3)", async () => {
    const h = harness({ commit: rec("stale-parent") });
    expect(failureOf(await h.call("syns.commit", { base: OLD, files: [{ path: "a.md", text: "A" }] }))).toMatchObject({ code: "conflict", reason: "stale_head", detail: { current: HEAD } });
    expect(h.runner.calls).toHaveLength(1);
  });

  it("with unpublished edits in the session's folder a write is conflict / checkout_dirty, and reads still work (A29, D11)", async () => {
    const h = harness({ commit: rec("checkout-dirty"), ls: rec("ls.ok") });
    const error = failureOf(await h.call("syns.commit", { base: HEAD, files: [{ path: "a.md", text: "A" }] }));
    expect(error).toMatchObject({ code: "conflict", reason: "checkout_dirty" });
    expect(error.message).not.toContain("checkout at");
    expect((await h.call("syns.ls")).ok).toBe(true);
  });

  it("a path named twice, or no change at all, is invalid_change and runs no process (A24)", async () => {
    const h = harness();
    const cases = [
      { files: [{ path: "a.md", text: "1" }, { path: "a.md", text: "2" }] },
      { files: [{ path: "a.md", text: "1" }], deletions: ["a.md"] },
      { deletions: ["a.md", "a.md"] },
      { files: [], deletions: [] },
      {},
    ];
    for (const params of cases) expect(failureOf(await h.call("syns.commit", { base: HEAD, ...params })), JSON.stringify(params)).toMatchObject({ code: "invalid_params", reason: "invalid_change" });
    expect(h.runner.calls).toHaveLength(0);
  });

  it("is not accepted without base (A30)", async () => {
    const h = harness();
    expect(failureOf(await h.call("syns.commit", { files: [{ path: "a.md", text: "A" }] })).code).toBe("invalid_params");
    expect(failureOf(await h.call("syns.commit", { base: "6", files: [{ path: "a.md", text: "A" }] })).code).toBe("invalid_params");
    expect(h.runner.calls).toHaveLength(0);
  });

  it("a text or a message beginning with -- is stored as text and changes no flag (A32)", async () => {
    const h = harness({ commit: rec("write.ok") });
    await h.call("syns.commit", { base: HEAD, message: "--repo=someone/else", files: [{ path: "a.md", text: "--parent=1\n--json" }] });
    const { args, stdin } = h.runner.calls[0]!;
    expect(args).toEqual(["commit", `--parent=${HEAD}`, "--message=--repo=someone/else", ...PROVENANCE, "--run=thr_page", "--json"]);
    expect(JSON.parse(stdin!).files[0].content).toBe("--parent=1\n--json");
  });

  it("a page can set none of the provenance (S1.5)", async () => {
    const h = harness();
    for (const key of ["integration", "trigger", "run"]) {
      expect(failureOf(await h.call("syns.commit", { base: HEAD, files: [{ path: "a.md", text: "A" }], [key]: "x" })).code).toBe("invalid_params");
    }
  });

  it("a changeset that changes nothing is success with the unchanged version and changed 0 (S1.17)", async () => {
    const h = harness({ commit: rec("write.unchanged") });
    expect(resultOf(await h.call("syns.commit", { base: HEAD, deletions: ["gone.md"] }))).toEqual({ version: HEAD, number: 6, changed: 0 });
  });

  it("refuses more than 64 files or 64 deletions, and a message over 500 characters", async () => {
    const h = harness();
    const many = Array.from({ length: 65 }, (_, i) => `f${i}.md`);
    expect(failureOf(await h.call("syns.commit", { base: HEAD, deletions: many })).code).toBe("invalid_params");
    expect(failureOf(await h.call("syns.commit", { base: HEAD, files: many.map((path) => ({ path, text: "" })) })).code).toBe("invalid_params");
    expect(failureOf(await h.call("syns.commit", { base: HEAD, message: "m".repeat(501), deletions: ["a.md"] })).code).toBe("invalid_params");
  });

  it("logs the method, the session, the path count and the outcome, never the text or the message (S2.19, S2.20)", async () => {
    const h = harness({ commit: rec("write.ok") });
    await h.call("syns.commit", { base: HEAD, message: "PRIVATE MESSAGE", files: [{ path: "a.md", text: "PRIVATE TEXT" }], deletions: ["b.md"] }, "thr_abc");
    expect(h.log).toHaveLength(1);
    expect(h.log[0]).toContain("syns.commit");
    expect(h.log[0]).toContain("thr_abc");
    expect(h.log[0]).toContain("paths=2");
    expect(h.log[0]).toContain("outcome=ok");
    expect(h.log[0]).not.toContain("PRIVATE");

    const stale = harness({ commit: rec("stale-parent") });
    await stale.call("syns.commit", { base: OLD, files: [{ path: "a.md", text: "A" }] });
    expect(stale.log[0]).toContain("outcome=stale_head");
  });
});
