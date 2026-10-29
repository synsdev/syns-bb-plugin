import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildDeclaration } from "../src/declaration.js";
import { METHODS } from "../src/methods/index.js";
import { validate, type Schema } from "../src/method.js";
import { scopeInside } from "../src/scope.js";
import { scopePatch } from "../src/scoped.js";
import { ok, rec, spawnFailed } from "./fake-runner.js";
import { HEAD, OLD, SAMPLES, failureOf, harness, resultOf } from "./harness.js";

/** A call's scope parameter (S1.25, S2.31, D85): paths count from the folder, the answer names nothing outside it. */
const APP = "apps/todo";
const args = (h: ReturnType<typeof harness>) => h.runner.calls.map((call) => call.args.join(" "));

describe("the scope parameter in the server half (S1.25, D85)", () => {
  it("is declared on every method, and named once in the guide, not in each method's line", () => {
    const declaration = buildDeclaration(METHODS, { agentInstructions: true });
    for (const method of declaration.methods) expect((method.params.properties as Record<string, unknown>).scope, method.name).toEqual({ type: "string", maxLength: 1024 });
    expect(declaration.guide).toContain("no other key is accepted but `scope`, a folder paths and answers then count from.");
    expect(declaration.guide).not.toMatch(/^- `syns\.[a-zA-Z]+` `\{[^`]*scope/m);
  });
  it("syns.ls {} lists only the folder: the CLI lists it at the session's folder, every run carries the scope, paths come back counted from it", async () => {
    const h = harness({ ls: ok({ commitSha: HEAD, version: 6, truncated: false, entries: [{ path: `${APP}/index.html`, type: "file", size: 9, sha: "a1" }, { path: `${APP}/data`, type: "dir", size: null, sha: null }, { path: "secret.md", type: "file", size: 1, sha: "b2" }] }) });
    const result = resultOf(await h.call("syns.ls", { scope: APP }));
    expect(h.runner.calls.map((call) => [call.cwd, call.scope, call.args.join(" ")])).toEqual([["/work/checkout", APP, `ls --json -- ${APP}`]]);
    expect(result).toMatchObject({ total: 3, entries: [{ path: "index.html" }, { path: "data" }] });
    expect((result.entries as unknown[]).length).toBe(2);
  });
  it("syns.ls with format lines cuts each line's path and drops a line outside", async () => {
    const h = harness({ ls: ok({ commitSha: HEAD, version: 6, truncated: false, entries: [{ path: `${APP}/a.md`, type: "file", size: 1, sha: "a1" }, { path: "apps/todo-other/b.md", type: "file", size: 1, sha: "b2" }] }) });
    expect(resultOf(await h.call("syns.ls", { scope: `${APP}/`, recursive: true, format: "lines" })).lines).toEqual(["a.md\ta1\t1"]);
    expect(args(h)).toEqual([`ls --recursive --json -- ${APP}`]);
  });
  it("a write's paths are inside the folder, and the text still travels on standard input", async () => {
    const h = harness({ write: rec("write.ok") });
    expect((await h.call("syns.write", { path: "list.json", text: "[]", base: HEAD, scope: APP })).ok).toBe(true);
    expect(h.runner.calls[0]).toMatchObject({ scope: APP, stdin: "[]" });
    expect(h.runner.calls[0]!.args.slice(-2)).toEqual(["--", `${APP}/list.json`]);
  });
  it("syns.commit and syns.readMany: every path and deletion counted from the folder, the answer's paths cut back", async () => {
    const commit = harness({ commit: ok({ commitSha: HEAD, version: 7, filesChanged: 2 }) });
    await commit.call("syns.commit", { base: HEAD, files: [{ path: "a.md", text: "a" }], deletions: ["old.md"], scope: APP });
    expect(commit.runner.calls[0]!.stdin).toContain(`${APP}/a.md`);
    expect(commit.runner.calls[0]!.stdin).toContain(`${APP}/old.md`);
    const read = harness({ cat: ok({ commitSha: HEAD, files: [{ path: `${APP}/a.md`, content: "a", size: 1, sha: "a1" }] }) });
    const result = resultOf(await read.call("syns.readMany", { paths: ["a.md"], scope: APP }));
    expect(read.runner.calls[0]!.stdin).toBe(`${APP}/a.md\n`);
    expect(result).toMatchObject({ files: [{ path: "a.md", text: "a" }], deferred: [] });
  });
  it("syns.glob and syns.grep: the pattern and the globs count from the folder, and the search runs under it", async () => {
    const glob = harness({ glob: ok({ commitSha: HEAD, version: 6, truncated: false, matches: [{ path: `${APP}/a.md`, size: 1, sha: "a1" }] }) });
    expect(resultOf(await glob.call("syns.glob", { pattern: "*.md", scope: APP })).matches).toEqual([{ path: "a.md", size: 1, blob: "a1" }]);
    expect(args(glob)).toEqual([`glob --path=${APP} --json -- ${APP}/*.md`]);
    const grep = harness({ grep: rec("grep.files.ok") });
    await grep.call("syns.grep", { pattern: "x", glob: ["**/*.md"], output: "files", scope: APP });
    expect(args(grep)[0]).toContain(`--path=${APP}`);
    expect(args(grep)[0]).toContain(`--glob=${APP}/**/*.md`);
  });
  it("syns.history with no path keeps only the commits that touched the folder: no author or message from elsewhere", async () => {
    const h = harness({ history: rec("history.ok") });
    const outside = resultOf(await h.call("syns.history", { scope: "notes" }));
    expect(outside.entries).toEqual([expect.objectContaining({ message: "proto: rm", paths: ["n29.md"] })]);
    expect(JSON.stringify(outside)).not.toContain("by hand");
    expect(args(h)).toEqual(["history --limit=20 --json"]);
  });
  it("syns.history with a path asks the CLI for that file inside the folder", async () => {
    const h = harness({ history: rec("history.file.ok") });
    expect(resultOf<{ entries: { paths: string[] }[] }>(await h.call("syns.history", { path: "n29.md", scope: "notes" })).entries.map((entry) => entry.paths)).toEqual([["n29.md"]]);
    expect(args(h)).toEqual(["history --file=notes/n29.md --limit=20 --json"]);
  });
  // Rows of CLI 0.3.25 for a file moved across or within the folder app/: each names its own path (B-0087).
  const fileHistory = async (name: string, params: Record<string, unknown>) => {
    const result = resultOf<{ total: number; entries: { number: number; message: string; paths: string[] }[] }>(await harness({ history: rec(name) }).call("syns.history", params));
    return { total: result.total, rows: result.entries.map((entry) => [entry.number, entry.paths]), text: JSON.stringify(result) };
  };
  it("syns.history with a path leaves out the versions from before the file came into the folder: no author or message from outside it (B-0087)", async () => {
    const answer = await fileHistory("history.file.moved-in.0325", { path: "outside.md", scope: "app" });
    expect(answer.rows).toEqual([[4, ["outside.md"]], [3, ["outside.md"]]]);
    expect(answer.text).not.toContain("at the root");
    expect(answer.text).not.toContain("Scratch for");
    expect(answer.total).toBe(4);
  });
  it("syns.history with a path keeps a move within the folder, both sides counted from it (B-0087)", async () => {
    expect((await fileHistory("history.file.moved-within.0325", { path: "a.json", scope: "app" })).rows).toEqual([[6, ["a.json"]], [5, ["old/a.json", "a.json"]], [1, ["old/a.json"]]]);
  });
  it("syns.history with a path leaves out what the file went through outside the folder, keeping the moves out and back in (B-0087)", async () => {
    const answer = await fileHistory("history.file.moved-out-back.0325", { path: "c.md", scope: "app" });
    expect(answer.rows).toEqual([[9, ["c.md"]], [7, ["c.md"]], [1, ["c.md"]]]);
    expect(answer.text).not.toContain("edit c.md at the root");
  });
  it("syns.history with a ../ path drops no version, counting each path from the folder (D92, B-0087)", async () => {
    const h = harness({ history: rec("history.file.moved-within.0325") });
    const result = resultOf<{ entries: { number: number; paths: string[] }[] }>(await h.call("syns.history", { path: "../a.json", scope: "app/old" }));
    expect(result.entries.map((entry) => [entry.number, entry.paths])).toEqual([[6, ["../a.json"]], [5, ["a.json", "../a.json"]], [1, ["a.json"]]]);
    expect(args(h)).toEqual(["history --file=app/a.json --limit=20 --json"]);
  });
  it("syns.history's offset counts the repository's versions, as total does: passed on unchanged under a scope (S1.27)", async () => {
    const h = harness({ history: rec("history.ok") });
    const result = resultOf(await h.call("syns.history", { scope: "notes", limit: 5, offset: 5 }));
    expect(args(h)).toEqual(["history --limit=5 --offset=5 --json"]);
    expect(result.total).toBe(6);
  });
  it("syns.diff counts a move inside the folder from it; one across its edge is an addition or a deletion, with no patch (A90, S1.26)", async () => {
    const files = [
      { path: `${APP}/c.md`, oldPath: `${APP}/a.md`, status: "renamed", diff: "rename" },
      { path: "b.md", oldPath: `${APP}/b.md`, status: "renamed", diff: "rename" },
      { path: `${APP}/o.md`, oldPath: "o.md", status: "renamed", diff: "rename" },
      { path: "x.md", oldPath: "y.md", status: "renamed", diff: "rename" },
    ];
    const h = harness({ diff: ok({ from: { sha: OLD, version: 4 }, to: { sha: HEAD, version: 6 }, files }) });
    expect(resultOf(await h.call("syns.diff", { from: OLD, to: HEAD, patch: true, scope: APP })).files).toEqual([
      { path: "c.md", oldPath: "a.md", status: "renamed", patch: "rename" },
      { path: "b.md", status: "deleted" },
      { path: "o.md", status: "added" },
    ]);
  });
  it("syns.diff's patch names every path as its entry does, counted from the folder; a hunk's text stays as written (S1.25, B-0080)", async () => {
    const A = APP;
    const files = [
      { path: `${A}/a.md`, status: "modified", diff: `diff --git a/${A}/a.md b/${A}/a.md\n--- a/${A}/a.md\n+++ b/${A}/a.md\n@@ -1,2 +1 @@\n-# a\n--- a/${A}/kept\n+++ b/${A}/kept\n` },
      { path: `${A}/b.md`, status: "deleted", diff: `diff --git a/${A}/b.md b/${A}/b.md\ndeleted file mode 100644\n--- a/${A}/b.md\n+++ /dev/null\n@@ -1 +0,0 @@\n-# b\n` },
      { path: `${A}/c.md`, status: "added", diff: `diff --git a/${A}/c.md b/${A}/c.md\nnew file mode 100644\nindex 0000000..890bd8b\n--- /dev/null\n+++ b/${A}/c.md\n@@ -0,0 +1 @@\n+# c\n` },
      { path: `${A}/old/a.json`, oldPath: `${A}/a.json`, status: "renamed", diff: `diff --git a/${A}/a.json b/${A}/old/a.json\nsimilarity index 100%\nrename from ${A}/a.json\nrename to ${A}/old/a.json\n` },
      { path: `${A}/d.md`, oldPath: `${A}/c.md`, status: "copied", diff: `diff --git a/${A}/c.md b/${A}/d.md\nsimilarity index 100%\ncopy from ${A}/c.md\ncopy to ${A}/d.md\n` },
      { path: `${A}/i.png`, status: "modified", diff: `diff --git a/${A}/i.png b/${A}/i.png\nindex 1..2 100644\nBinary files a/${A}/i.png and b/${A}/i.png differ\n` },
      { path: `${A}/n.png`, status: "added", diff: `diff --git a/${A}/n.png b/${A}/n.png\nnew file mode 100644\nBinary files /dev/null and b/${A}/n.png differ\n` },
      { path: `${A}/a b.md`, status: "modified", diff: `diff --git a/${A}/a b.md b/${A}/a b.md\n--- a/${A}/a b.md\n+++ b/${A}/a b.md\n@@ -1 +1 @@\n-x\n+y\n` },
      { path: `${A}/x\tb`, status: "modified", diff: `diff --git "a/${A}/x\\tb" "b/${A}/x\\tb"\n--- "a/${A}/x\\tb"\n+++ "b/${A}/x\\tb"\n@@ -1 +1 @@\n-x\n+y\n` },
    ];
    const h = harness({ diff: ok({ from: { sha: OLD, version: 4 }, to: { sha: HEAD, version: 6 }, files }) });
    const patches = (resultOf(await h.call("syns.diff", { from: OLD, to: HEAD, patch: true, scope: APP })).files as { patch: string }[]).map((file) => file.patch);
    expect(patches).toEqual([
      "diff --git a/a.md b/a.md\n--- a/a.md\n+++ b/a.md\n@@ -1,2 +1 @@\n-# a\n--- a/" + A + "/kept\n+++ b/" + A + "/kept\n",
      "diff --git a/b.md b/b.md\ndeleted file mode 100644\n--- a/b.md\n+++ /dev/null\n@@ -1 +0,0 @@\n-# b\n",
      "diff --git a/c.md b/c.md\nnew file mode 100644\nindex 0000000..890bd8b\n--- /dev/null\n+++ b/c.md\n@@ -0,0 +1 @@\n+# c\n",
      "diff --git a/a.json b/old/a.json\nsimilarity index 100%\nrename from a.json\nrename to old/a.json\n",
      "diff --git a/c.md b/d.md\nsimilarity index 100%\ncopy from c.md\ncopy to d.md\n",
      "diff --git a/i.png b/i.png\nindex 1..2 100644\nBinary files a/i.png and b/i.png differ\n",
      "diff --git a/n.png b/n.png\nnew file mode 100644\nBinary files /dev/null and b/n.png differ\n",
      "diff --git a/a b.md b/a b.md\n--- a/a b.md\n+++ b/a b.md\n@@ -1 +1 @@\n-x\n+y\n",
      'diff --git "a/x\\tb" "b/x\\tb"\n--- "a/x\\tb"\n+++ "b/x\\tb"\n@@ -1 +1 @@\n-x\n+y\n',
    ]);
    const plain = harness({ diff: ok({ from: { sha: OLD, version: 4 }, to: { sha: HEAD, version: 6 }, files }) });
    expect((resultOf(await plain.call("syns.diff", { from: OLD, to: HEAD, patch: true })).files as { patch: string }[]).map((file) => file.patch)).toEqual(files.map((file) => file.diff));
  });
  it("scopePatch() reads each file's header in a patch of several, and leaves a path outside as served (B-0080, for a method whose patch spans files)", () => {
    const two = `diff --git a/${APP}/a.md b/${APP}/a.md\n--- a/${APP}/a.md\n+++ b/${APP}/a.md\n@@ -1 +1 @@\n-x\n+y\ndiff --git a/${APP}/b.md b/${APP}/b.md\n--- a/${APP}/b.md\n+++ b/${APP}/b.md\n@@ -1 +1 @@\n--- a/${APP}/kept\n+y\n`;
    expect(scopePatch(two, APP)).toBe("diff --git a/a.md b/a.md\n--- a/a.md\n+++ b/a.md\n@@ -1 +1 @@\n-x\n+y\ndiff --git a/b.md b/b.md\n--- a/b.md\n+++ b/b.md\n@@ -1 +1 @@\n--- a/" + APP + "/kept\n+y\n");
    const outside = `diff --git a/o.md b/${APP}/o.md\nsimilarity index 100%\nrename from o.md\nrename to ${APP}/o.md\n--- a/o.md\n+++ b/${APP}/o.md\n`;
    expect(scopePatch(outside, APP)).toBe(outside.replace(`rename to ${APP}/o.md`, "rename to o.md").replace(`+++ b/${APP}/o.md`, "+++ b/o.md"));
  });
  it("scopePatch() splits a diff --git or Binary files line where the header's other lines name its sides, though a path holds ' b/<scope>/' (B-0080, VERIFY F1)", () => {
    const P = "probe-app", odd = `${P}/a b/${P}/c.md`;
    const edit = `diff --git a/${odd} b/${odd}\nindex 1..2 100644\n--- a/${odd}\n+++ b/${odd}\n@@ -1 +1 @@\n-x\n+y\n`;
    expect(scopePatch(edit, P)).toBe(`diff --git a/a b/${P}/c.md b/a b/${P}/c.md\nindex 1..2 100644\n--- a/a b/${P}/c.md\n+++ b/a b/${P}/c.md\n@@ -1 +1 @@\n-x\n+y\n`);
    const move = `diff --git a/${odd} b/${P}/d.md\nsimilarity index 100%\nrename from ${odd}\nrename to ${P}/d.md\n`;
    expect(scopePatch(move, P)).toBe(`diff --git a/a b/${P}/c.md b/d.md\nsimilarity index 100%\nrename from a b/${P}/c.md\nrename to d.md\n`);
    const back = `diff --git a/${P}/d.md b/${odd}\nsimilarity index 100%\nrename from ${P}/d.md\nrename to ${odd}\n`;
    expect(scopePatch(back, P)).toBe(`diff --git a/d.md b/a b/${P}/c.md\nsimilarity index 100%\nrename from d.md\nrename to a b/${P}/c.md\n`);
    const binary = `diff --git a/${odd}.png b/${odd}.png\nindex 1..2 100644\nBinary files a/${odd}.png and b/${odd}.png differ\ndiff --git a/${odd}.png b/${odd}.png\nnew file mode 100644\nBinary files /dev/null and b/${odd}.png differ\n`;
    expect(scopePatch(binary, P)).toBe(binary.replaceAll(`a/${odd}`, `a/a b/${P}/c.md`).replaceAll(`b/${odd}`, `b/a b/${P}/c.md`));
  });
  it("syns.diff's patch recorded from CLI 0.3.25 for a move inside an app reads from the app's folder (B-0080, B-0082 H-app-move-diff)", async () => {
    const h = harness({ diff: rec("diff.renamed.0325") });
    expect(resultOf(await h.call("syns.diff", { from: OLD, to: HEAD, patch: true, scope: "app" })).files).toEqual([
      { path: "c.md", oldPath: "a.md", status: "renamed", patch: "diff --git a/a.md b/c.md\nsimilarity index 100%\nrename from a.md\nrename to c.md\n" },
      { path: "b.md", status: "deleted" },
      { path: "o.md", status: "added" },
    ]);
  });
  it("syns.diff drops the files outside the folder", async () => {
    const h = harness({ diff: ok({ from: { sha: OLD, version: 4 }, to: { sha: HEAD, version: 6 }, files: [{ path: `${APP}/a.md`, status: "modified" }, { path: "README.md", status: "modified" }] }) });
    expect(resultOf(await h.call("syns.diff", { from: OLD, to: HEAD, scope: APP })).files).toEqual([{ path: "a.md", status: "modified" }]);
  });
  it("syns.repo and syns.whoami name no path: the scope is checked, the answer is the repository's", async () => {
    const h = harness({ repo: rec("repo.ok") });
    expect(resultOf(await h.call("syns.repo", { scope: APP }))).toMatchObject({ owner: expect.any(String) });
    expect(h.runner.calls[0]).toMatchObject({ scope: APP, args: ["repo", "--json"] });
  });
  it("a scope the host half finds outside the session's folder is bad_scope", async () => {
    const h = harness({ write: spawnFailed("scope_outside") });
    expect(failureOf(await h.call("syns.write", { path: "a", text: "a", base: HEAD, scope: "escape" }))).toMatchObject({ code: "invalid_params", reason: "bad_scope" });
  });
  it("a scope that breaks the path rule, or is no string, is bad_scope and runs nothing; empty is none", async () => {
    for (const scope of ["..", "../x", "a/../b", ".", "/abs", "-x", "a\\b", 3, null, ["a"]]) {
      const h = harness({ ls: rec("ls.ok") });
      expect(failureOf(await h.call("syns.ls", { scope })), JSON.stringify(scope)).toMatchObject({ reason: "bad_scope" });
      expect(h.runner.calls, JSON.stringify(scope)).toHaveLength(0);
    }
    const h = harness({ ls: rec("ls.ok") });
    expect(resultOf(await h.call("syns.ls", { scope: "" })).entries).toHaveLength(2);
    expect(h.runner.calls[0]!.scope).toBeUndefined();
  });
  it("a write's path that leaves the folder, or a read's that leaves the session's, is bad_scope, and runs nothing; without a scope it is invalid_params as before", async () => {
    for (const [method, params] of [["syns.write", { path: "../x", text: "a", base: HEAD }], ["syns.write", { path: "/x", text: "a", base: HEAD }], ["syns.commit", { base: HEAD, deletions: ["a/../../x"] }], ["syns.glob", { pattern: "../../../*.md" }], ["syns.readMany", { paths: ["ok.md", "../../../x"] }]] as const) {
      const h = harness();
      expect(failureOf(await h.call(method, { ...params, scope: APP })), method).toMatchObject({ code: "invalid_params", reason: "bad_scope" });
      expect(h.runner.calls, method).toHaveLength(0);
    }
    expect(failureOf(await harness().call("syns.write", { path: "../x", text: "a", base: HEAD })).reason).toBeUndefined();
  });
  it("the methods acting on the whole repository, its people or Syns refuse any scope, and run nothing", async () => {
    const whole = METHODS.filter((method) => method.unscoped).map((method) => method.name).sort();
    expect(whole).toEqual(["syns.collaboratorAdd", "syns.collaboratorRemove", "syns.collaboratorRole", "syns.collaborators", "syns.enableChecks", "syns.folderVisibility", "syns.place", "syns.repoVisibility", "syns.share", "syns.shareInfo", "syns.unshare"]);
    for (const name of whole) {
      const h = harness();
      expect(failureOf(await h.call(name, { ...SAMPLES[name], scope: APP })), name).toMatchObject({ reason: "bad_scope" });
      expect(h.runner.calls, name).toHaveLength(0);
    }
  });
  it("syns.explore and syns.users read nothing of the repository: a scoped call runs as an unscoped one, in the checkout (D93)", async () => {
    for (const [name, verb] of [["syns.explore", "explore"], ["syns.users", "users"]] as const) {
      const plain = harness({ [verb]: rec(`${verb}.ok`) }), scoped = harness({ [verb]: rec(`${verb}.ok`) });
      const a = await plain.call(name, SAMPLES[name]), b = await scoped.call(name, { ...SAMPLES[name], scope: APP });
      expect(b, name).toEqual(a);
      expect(resultOf(b), name).toBeDefined();
      expect(scoped.runner.calls.map((c) => [c.cwd, c.args.join(" ")]), name).toEqual(plain.runner.calls.map((c) => [c.cwd, c.args.join(" ")]));
    }
  });
  it("a path the CLI answers outside the folder in a single-file answer is never passed on", async () => {
    const h = harness({ cat: ok({ commitSha: HEAD, version: 6, path: "secret.md", content: "x", totalLines: 1, size: 1, sha: "s" }) });
    expect(failureOf(await h.call("syns.read", { path: "a.md", scope: APP })).code).toBe("handler_error");
  });
});

describe("a read's ../ reaches the rest of the session's folder; a write's stays in the folder (S1.25, Q-0025, B-0083)", () => {
  const APPS = "tools/app";
  it("syns.read of ../../notes/plan.md reads notes/plan.md at the session's folder, and answers the path as asked", async () => {
    const h = harness({ read: ok({ commitSha: HEAD, version: 6, path: "notes/plan.md", content: "plan", offset: 1, limit: 1, totalLines: 1, size: 4, sha: "p1" }) });
    const result = resultOf(await h.call("syns.read", { path: "../../notes/plan.md", scope: APPS }));
    expect(h.runner.calls.map((call) => [call.cwd, call.scope, call.args.at(-1)])).toEqual([["/work/checkout", APPS, "notes/plan.md"]]);
    expect(result).toMatchObject({ path: "../../notes/plan.md", text: "plan" });
  });
  it("syns.ls of .. lists the app's neighbours counted from the folder, none dropped", async () => {
    const h = harness({ ls: ok({ commitSha: HEAD, version: 6, truncated: false, entries: [{ path: "tools/app", type: "dir", size: null, sha: null }, { path: "tools/other", type: "dir", size: null, sha: null }, { path: "tools/README.md", type: "file", size: 1, sha: "r1" }] }) });
    const result = resultOf(await h.call("syns.ls", { path: "..", scope: APPS }));
    expect(args(h)).toEqual(["ls --json -- tools"]);
    expect((result.entries as { path: string }[]).map((entry) => entry.path)).toEqual(["../app", "../other", "../README.md"]);
  });
  it("syns.ls of ../.. lists the session's folder itself, every path counted with ../../", async () => {
    const h = harness({ ls: ok({ commitSha: HEAD, version: 6, truncated: false, entries: [{ path: "README.md", type: "file", size: 1, sha: "r1" }, { path: "tools", type: "dir", size: null, sha: null }] }) });
    const result = resultOf(await h.call("syns.ls", { path: "../..", scope: APPS }));
    expect(args(h)).toEqual(["ls --json"]);
    expect((result.entries as { path: string }[]).map((entry) => entry.path)).toEqual(["../../README.md", "../../tools"]);
  });
  it("syns.readMany mixes the folder's own files and ../ ones, each answered as asked", async () => {
    const h = harness({ cat: ok({ commitSha: HEAD, files: [{ path: `${APPS}/a.md`, content: "a", size: 1, sha: "a1" }, { path: "tools/shared/theme.css", content: "b", size: 1, sha: "b1" }] }) });
    const result = resultOf(await h.call("syns.readMany", { paths: ["a.md", "../shared/theme.css"], scope: APPS }));
    expect(h.runner.calls[0]!.stdin).toBe(`${APPS}/a.md\ntools/shared/theme.css\n`);
    expect(result).toMatchObject({ files: [{ path: "a.md", text: "a" }, { path: "../shared/theme.css", text: "b" }] });
  });
  it("syns.readBinary of ../img.png reads tools/img.png", async () => {
    const h = harness({ cat: ok({ commitSha: HEAD, version: 6, path: "tools/img.png", contentBase64: "iVBORw0KGgo=", size: 8, sha: "i1", mediaType: "image/png" }) });
    const result = resultOf(await h.call("syns.readBinary", { path: "../img.png", scope: APPS }));
    expect(h.runner.calls[0]!.args.at(-1)).toBe("tools/img.png");
    expect(result.path).toBe("../img.png");
  });
  it("syns.glob of ../*.md searches the folder it climbs to", async () => {
    const h = harness({ glob: ok({ commitSha: HEAD, version: 6, truncated: false, matches: [{ path: "tools/a.md", size: 1, sha: "a1" }] }) });
    expect(resultOf(await h.call("syns.glob", { pattern: "../*.md", scope: APPS })).matches).toEqual([{ path: "../a.md", size: 1, blob: "a1" }]);
    expect(args(h)).toEqual(["glob --path=tools --json -- tools/*.md"]);
  });
  it("syns.grep with a ../../ glob searches the whole session's folder and answers ../../ paths", async () => {
    const h = harness({ grep: ok({ commitSha: HEAD, version: 6, output: "files", truncated: false, files: ["notes/a.md"], skipped: [] }) });
    const result = resultOf(await h.call("syns.grep", { pattern: "x", glob: ["../../notes/**"], output: "files", scope: APPS }));
    expect(args(h)[0]).not.toContain("--path=");
    expect(args(h)[0]).toContain("--glob=notes/**");
    expect(JSON.stringify(result)).toContain("../../notes/a.md");
  });
  it("syns.history of a ../ file asks for it at the session's folder and answers its paths counted from the folder", async () => {
    const h = harness({ history: rec("history.file.ok") });
    const result = resultOf(await h.call("syns.history", { path: "../notes/n01.md", scope: "tools" }));
    expect(args(h)).toEqual(["history --file=notes/n01.md --limit=20 --json"]);
    expect((result.entries as unknown[]).length).toBeGreaterThan(0);
    expect(JSON.stringify(result)).toContain("../notes/n01.md");
  });
  it("the declaration lets a read's ../ reach the plugin, as the host checks a call against it first; a write's .. stays refused there (VERIFY F1)", () => {
    const declared = new Map(buildDeclaration(METHODS, { agentInstructions: true }).methods.map((m) => [m.name, m.params as Schema]));
    for (const [method, params] of [
      ["syns.read", { path: "../../notes/plan.md" }], ["syns.read", { path: "../../README.md" }], ["syns.ls", { path: ".." }],
      ["syns.ls", { path: "../.." }], ["syns.readMany", { paths: ["a.md", "../shared/b.md"] }], ["syns.readBinary", { path: "../img.png" }],
      ["syns.history", { path: "../notes/plan.md" }], ["syns.history", { path: "../.." }], ["syns.glob", { pattern: "*.md", path: "../notes" }],
      ["syns.grep", { pattern: "x", path: "../.." }], ["syns.read", { path: "a.md" }],
    ] as const) expect(validate(declared.get(method)!, { ...params, scope: APPS }), `${method} ${JSON.stringify(params)}`).toBeNull();
    for (const [method, params] of [
      ["syns.write", { path: "../x.md", text: "", base: HEAD }], ["syns.rm", { path: "..", base: HEAD }], ["syns.move", { from: "a.md", to: "../a.md", base: HEAD }],
      ["syns.read", { path: "a/../b.md" }], ["syns.read", { path: "../a/../b.md" }], ["syns.read", { path: "../" }], ["syns.read", { path: "..//x" }],
      ["syns.read", { path: "../-x" }], ["syns.read", { path: "/x" }], ["syns.read", { path: "./x" }],
    ] as const) expect(validate(declared.get(method)!, { ...params, scope: APPS }), `${method} ${JSON.stringify(params)}`).not.toBeNull();
  });
  it("a ../ that climbs above the session's folder, a .. after a path's start, and a leading / are bad_scope and run nothing", async () => {
    for (const [method, params] of [
      ["syns.read", { path: "../../../x.md" }],
      ["syns.ls", { path: "../../.." }],
      ["syns.read", { path: "../a/../b.md" }],
      ["syns.read", { path: "a/../b.md" }],
      ["syns.read", { path: "/x.md" }],
      ["syns.glob", { pattern: "../../../*.md" }],
      ["syns.readMany", { paths: ["ok.md", "../../../x"] }],
      ["syns.grep", { pattern: "x", glob: ["../a/../**"] }],
    ] as const) {
      const h = harness();
      expect(failureOf(await h.call(method, { ...params, scope: APPS })), JSON.stringify(params)).toMatchObject({ code: "invalid_params", reason: "bad_scope" });
      expect(h.runner.calls, JSON.stringify(params)).toHaveLength(0);
    }
  });
  it("syns.history of .. up to the session's folder is the session's whole history, none dropped", async () => {
    const h = harness({ history: rec("history.ok") });
    const result = resultOf(await h.call("syns.history", { path: "..", scope: "notes" }));
    expect(args(h)).toEqual(["history --limit=20 --json"]);
    expect(JSON.stringify(result)).toContain("by hand");
  });
  it("a read's ../ that resolves to a leading / is bad_scope; one landing back in the folder is the same path twice", async () => {
    const glob = harness();
    expect(failureOf(await glob.call("syns.glob", { pattern: "../..//etc/*", scope: APPS })).reason).toBe("bad_scope");
    expect(glob.runner.calls).toHaveLength(0);
    const many = harness();
    expect(failureOf(await many.call("syns.readMany", { paths: ["a.md", "../app/a.md"], scope: APPS })).message).toContain("distinct");
    expect(many.runner.calls).toHaveLength(0);
  });
  it("every write with a .. path is bad_scope and runs nothing (D91 point 3)", async () => {
    for (const [method, params] of [
      ["syns.write", { path: "../x.md", text: "a", base: HEAD }],
      ["syns.writeBinary", { path: "../a.png", base64: "iVBORw0KGgo=", base: HEAD }],
      ["syns.edit", { path: "../x.md", old: "a", new: "b", base: HEAD }],
      ["syns.rm", { path: "../x.md", base: HEAD }],
      ["syns.move", { from: "a.md", to: "../b.md", base: HEAD }],
      ["syns.move", { from: "../a.md", to: "b.md", base: HEAD }],
      ["syns.copy", { from: "../a.md", to: "b.md", base: HEAD }],
      ["syns.commit", { base: HEAD, files: [{ path: "../a.md", text: "a" }] }],
      ["syns.commit", { base: HEAD, deletions: ["../old.md"] }],
      ["syns.revert", { path: "../x.md", to: OLD, base: HEAD }],
    ] as const) {
      const h = harness();
      expect(failureOf(await h.call(method, { ...params, scope: APPS })), `${method} ${JSON.stringify(params)}`).toMatchObject({ code: "invalid_params", reason: "bad_scope" });
      expect(h.runner.calls, method).toHaveLength(0);
    }
  });
  it("a call naming no ../ answers as before: syns.ls {} and syns.history {} drop what is outside", async () => {
    const ls = harness({ ls: ok({ commitSha: HEAD, version: 6, truncated: false, entries: [{ path: `${APPS}/index.html`, type: "file", size: 9, sha: "a1" }, { path: "tools/other/x.md", type: "file", size: 1, sha: "b2" }] }) });
    expect(JSON.stringify(resultOf(await ls.call("syns.ls", { scope: APPS })))).toBe(JSON.stringify({ version: HEAD, number: 6, truncated: false, total: 2, nextOffset: null, entries: [{ path: "index.html", type: "file", size: 9, blob: "a1" }] }));
    const history = harness({ history: rec("history.ok") });
    const entries = resultOf(await history.call("syns.history", { scope: "notes" })).entries as { paths: string[] }[];
    expect(entries.map((entry) => entry.paths)).toEqual([["n29.md"]]);
  });
});

describe("the host half's check of a scope parameter (S2.31, D85)", () => {
  const made: string[] = [];
  afterAll(async () => {
    for (const dir of made) await rm(dir, { recursive: true, force: true });
  });
  it("scopeInside(): a plain folder, one not on disk yet, a link inside; refusals: a link out, a file's child, a sibling", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "scope-param-")));
    const outside = await mkdtemp(join(tmpdir(), "scope-param-out-"));
    made.push(root, outside, `${root}-sibling`);
    await mkdir(join(root, "apps", "todo"), { recursive: true });
    await mkdir(`${root}-sibling`);
    await symlink(outside, join(root, "escape"));
    await symlink(join(root, "apps"), join(root, "alias"));
    await symlink(join(outside, "not-yet"), join(root, "dangling"));
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(root, "file.md"), "x");
    expect(await scopeInside(root, "apps/todo")).toBe(true); // no .syns.yaml needed
    expect(await scopeInside(root, "apps/new/deeper")).toBe(true); // not on disk: judged by its nearest parent
    expect(await scopeInside(root, "alias/todo")).toBe(true);
    expect(await scopeInside(root, "escape")).toBe(false);
    expect(await scopeInside(root, "escape/inner")).toBe(false);
    expect(await scopeInside(root, "file.md/x")).toBe(false);
    expect(await scopeInside(root, "dangling")).toBe(false); // a link to nothing yet: it could point outside once its target appears
    expect(await scopeInside(root, "dangling/inner")).toBe(false);
    expect(await scopeInside(root, "../" + `${root.split("/").pop()}-sibling`)).toBe(false);
    expect(await scopeInside(join(root, "missing-root"), "apps")).toBe(false);
  });
});
