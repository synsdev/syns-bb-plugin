import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildDeclaration } from "../src/declaration.js";
import { METHODS } from "../src/methods/index.js";
import { scopeInside } from "../src/scope.js";
import { ok, rec, spawnFailed } from "./fake-runner.js";
import { HEAD, OLD, SAMPLES, failureOf, harness, resultOf } from "./harness.js";

/** A call's scope parameter (S1.25, S2.31, D85): paths count from the folder, the answer names nothing outside it. */
const APP = "apps/todo";
const args = (h: ReturnType<typeof harness>) => h.runner.calls.map((call) => call.args.join(" "));

describe("the scope parameter in the server half (S1.25, D85)", () => {
  it("is declared on every method, and named once in the guide, not in each method's line", () => {
    const declaration = buildDeclaration(METHODS, { agentInstructions: true });
    for (const method of declaration.methods) expect((method.params.properties as Record<string, unknown>).scope, method.name).toEqual({ type: "string", maxLength: 1024 });
    expect(declaration.guide).toContain("no other key is accepted but `scope`, a folder that paths and answers then count from.");
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
    expect((await h.call("syns.history", { path: "n29.md", scope: "notes" })).ok).toBe(true);
    expect(args(h)).toEqual(["history --file=notes/n29.md --limit=20 --json"]);
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
  it("a path or pattern that leaves the folder is bad_scope, and runs nothing; without a scope it is invalid_params as before", async () => {
    for (const [method, params] of [["syns.write", { path: "../x", text: "a", base: HEAD }], ["syns.write", { path: "/x", text: "a", base: HEAD }], ["syns.commit", { base: HEAD, deletions: ["a/../../x"] }], ["syns.glob", { pattern: "../*.md" }], ["syns.readMany", { paths: ["ok.md", "../x"] }]] as const) {
      const h = harness();
      expect(failureOf(await h.call(method, { ...params, scope: APP })), method).toMatchObject({ code: "invalid_params", reason: "bad_scope" });
      expect(h.runner.calls, method).toHaveLength(0);
    }
    expect(failureOf(await harness().call("syns.write", { path: "../x", text: "a", base: HEAD })).reason).toBeUndefined();
  });
  it("the methods acting on the whole repository, its people or Syns refuse any scope, and run nothing", async () => {
    const whole = METHODS.filter((method) => method.unscoped).map((method) => method.name).sort();
    expect(whole).toEqual(["syns.collaboratorAdd", "syns.collaboratorRemove", "syns.collaboratorRole", "syns.collaborators", "syns.enableChecks", "syns.explore", "syns.folderVisibility", "syns.place", "syns.repoVisibility", "syns.share", "syns.shareInfo", "syns.unshare", "syns.users"]);
    for (const name of whole) {
      const h = harness();
      expect(failureOf(await h.call(name, { ...SAMPLES[name], scope: APP })), name).toMatchObject({ reason: "bad_scope" });
      expect(h.runner.calls, name).toHaveLength(0);
    }
  });
  it("a path the CLI answers outside the folder in a single-file answer is never passed on", async () => {
    const h = harness({ cat: ok({ commitSha: HEAD, version: 6, path: "secret.md", content: "x", totalLines: 1, size: 1, sha: "s" }) });
    expect(failureOf(await h.call("syns.read", { path: "a.md", scope: APP })).code).toBe("handler_error");
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
