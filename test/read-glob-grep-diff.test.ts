import { describe, expect, it } from "vitest";
import { ok, rec } from "./fake-runner.js";
import { HEAD, OLD, failureOf, harness, resultOf } from "./harness.js";

const BLOB = "7846c4f86a6274cdbd004ebed3985e953621223e";

describe("syns.read", () => {
  it("returns the requested window and totalLines, built field by field (A20, S1.7)", async () => {
    const h = harness({ read: rec("read.ok") });
    expect(resultOf(await h.call("syns.read", { path: "README.md", offset: 2, limit: 2 }))).toEqual({
      version: HEAD,
      number: 6,
      path: "README.md",
      text: "\nA throwaway repository the Syns bb plugin is tested against. Nothing here matters.",
      offset: 2,
      limit: 2,
      totalLines: 3,
      size: 94,
      blob: BLOB,
    });
    expect(h.runner.calls.map((call) => call.args)).toEqual([["read", "--offset=2", "--limit=2", "--json", "--", "README.md"]]);
  });
  it("reads from line 1, 2000 lines, at the head by default; a version is passed as an option (S1.3)", async () => {
    const h = harness({ read: rec("read.ok") });
    await h.call("syns.read", { path: "README.md" });
    await h.call("syns.read", { path: "README.md", version: OLD });
    expect(h.runner.calls[0]!.args).toEqual(["read", "--offset=1", "--limit=2000", "--json", "--", "README.md"]);
    expect(h.runner.calls[1]!.args).toEqual(["read", "--offset=1", "--limit=2000", `--version=${OLD}`, "--json", "--", "README.md"]);
  });
  it("an offset past the end is success with an empty text and the true totalLines", async () => {
    const h = harness({ read: rec("read.past-end") });
    expect(resultOf(await h.call("syns.read", { path: "README.md", offset: 999, limit: 2 }))).toMatchObject({ text: "", offset: 999, totalLines: 3 });
  });
  it("refuses an offset under 1, a limit outside 1 to 5000, and a call without path, before any process", async () => {
    const h = harness();
    for (const params of [{ path: "a.md", offset: 0 }, { path: "a.md", limit: 0 }, { path: "a.md", limit: 5001 }, { path: "a.md", offset: 1.5 }, {}]) {
      expect(failureOf(await h.call("syns.read", params)).code, JSON.stringify(params)).toBe("invalid_params");
    }
    expect(h.runner.calls).toHaveLength(0);
  });
  it("a missing path is not_found once repo shows the repository is reachable (A37)", async () => {
    const h = harness({ read: rec("not-found-404"), repo: rec("repo.ok") });
    expect(failureOf(await h.call("syns.read", { path: "nope.md" })).code).toBe("not_found");
  });
  it("a success without a text is handler_error, never a result with a hole (S3.7)", async () => {
    const h = harness({ read: ok({ commitSha: HEAD, version: 6, path: "a.png", content: null, offset: 1, limit: 2000, totalLines: 0, size: 3, sha: BLOB }) });
    expect(failureOf(await h.call("syns.read", { path: "a.png" })).code).toBe("handler_error");
  });
});

describe("syns.glob", () => {
  it("returns its declared shape; the pattern follows --, path and version are options (A21, S2.11)", async () => {
    const h = harness({ glob: rec("glob.ok") });
    expect(resultOf(await h.call("syns.glob", { pattern: "n0*.md", path: "notes", version: OLD }))).toEqual({
      version: HEAD,
      number: 6,
      truncated: false,
      total: 2,
      nextOffset: null,
      matches: [
        { path: "notes/n01.md", size: 2029, blob: "3eaf8d28a87ad50859fb7544653c1ef7823d7827" },
        { path: "notes/n02.md", size: 2030, blob: "c7dd1140ced2312ec578ba0c7c9e25ead011c830" },
      ],
    });
    expect(h.runner.calls.map((call) => call.args)).toEqual([["glob", "--path=notes", `--version=${OLD}`, "--json", "--", "n0*.md"]]);
  });
  it("no match is success with no matches", async () => {
    const h = harness({ glob: rec("glob.none") });
    expect(resultOf(await h.call("syns.glob", { pattern: "zzz*" })).matches).toEqual([]);
    expect(h.runner.calls[0]!.args).toEqual(["glob", "--json", "--", "zzz*"]);
  });
  it("a pattern beginning with -- is a pattern, not a flag (A32)", async () => {
    const h = harness({ glob: rec("glob.none") });
    await h.call("syns.glob", { pattern: "--repo=someone/else" });
    expect(h.runner.calls[0]!.args).toEqual(["glob", "--json", "--", "--repo=someone/else"]);
  });
  it("a pattern that does not parse is invalid_params / bad_pattern", async () => {
    const h = harness({ glob: rec("bad-pattern.glob") });
    const error = failureOf(await h.call("syns.glob", { pattern: "[" }));
    expect(error).toMatchObject({ code: "invalid_params", reason: "bad_pattern" });
    expect(error.message).not.toContain("unclosed");
  });
  it("refuses an empty pattern and one over 512 characters", async () => {
    const h = harness();
    for (const pattern of ["", "x".repeat(513)]) expect(failureOf(await h.call("syns.glob", { pattern })).code).toBe("invalid_params");
    expect(h.runner.calls).toHaveLength(0);
  });
});

describe("syns.grep", () => {
  it("content, the default: matches with line numbers and context, the pattern after -- (A21)", async () => {
    const h = harness({ grep: rec("grep.content.ok") });
    expect(resultOf(await h.call("syns.grep", { pattern: "Note", context: 1 }))).toEqual({
      version: HEAD,
      number: 6,
      output: "content",
      truncated: false,
      skipped: [],
      matches: [
        { path: "notes/n01.md", line: 5, text: "# Note 01", context: [{ line: 4, text: "" }, { line: 6, text: "" }] },
        { path: "notes/n02.md", line: 5, text: "# Note 02", context: [] },
      ],
    });
    expect(h.runner.calls.map((call) => call.args)).toEqual([["grep", "--line-number", "--context=1", "--output=content", "--head-limit=200", "--json", "--", "Note"]]);
  });
  it("files: the paths that match (A21)", async () => {
    const h = harness({ grep: rec("grep.files.ok") });
    expect(resultOf(await h.call("syns.grep", { pattern: "Note", output: "files", headLimit: 2 }))).toEqual({ version: HEAD, number: 6, output: "files", truncated: false, skipped: [], files: ["notes/n01.md", "notes/n02.md"] });
    // The CLI refuses --line-number and --context under any output but content.
    expect(h.runner.calls[0]!.args).toEqual(["grep", "--output=files", "--head-limit=2", "--json", "--", "Note"]);
  });
  it("count: how many matches in each path (A21)", async () => {
    const h = harness({ grep: rec("grep.count.ok") });
    expect(resultOf(await h.call("syns.grep", { pattern: "note", output: "count", ignoreCase: true, path: "notes" }))).toEqual({
      version: HEAD,
      number: 6,
      output: "count",
      truncated: false,
      skipped: [],
      counts: [{ path: "notes/n01.md", count: 1 }, { path: "notes/n02.md", count: 1 }],
    });
    expect(h.runner.calls[0]!.args).toEqual(["grep", "--path=notes", "--ignore-case", "--output=count", "--head-limit=200", "--json", "--", "note"]);
  });
  it("passes each glob as its own --glob=, and the version", async () => {
    const h = harness({ grep: rec("grep.content.ok") });
    await h.call("syns.grep", { pattern: "Note", glob: ["notes/*.md", "--json"], version: OLD });
    expect(h.runner.calls[0]!.args).toEqual(["grep", "--glob=notes/*.md", "--glob=--json", "--line-number", "--output=content", "--head-limit=200", `--version=${OLD}`, "--json", "--", "Note"]);
  });
  it("passes on which paths the CLI skipped, and its truncated flag", async () => {
    const h = harness({ grep: ok({ commitSha: HEAD, version: 6, pattern: "x", output: "files", truncated: true, skipped: [{ path: "logo.png", reason: "binary" }], files: [] }) });
    expect(resultOf(await h.call("syns.grep", { pattern: "x", output: "files" }))).toMatchObject({ truncated: true, skipped: [{ path: "logo.png", reason: "binary" }] });
  });
  it("a pattern that does not parse is invalid_params / bad_pattern, in the plugin's own words", async () => {
    const h = harness({ grep: rec("bad-pattern.grep") });
    const error = failureOf(await h.call("syns.grep", { pattern: "(" }));
    expect(error).toMatchObject({ code: "invalid_params", reason: "bad_pattern" });
    expect(error.message).not.toContain("regex parse error");
  });
  it("a success without the rows its output promises is handler_error (S3.7)", async () => {
    const h = harness({ grep: ok({ commitSha: HEAD, version: 6, pattern: "Note", output: "count", truncated: false, skipped: [] }) });
    expect(failureOf(await h.call("syns.grep", { pattern: "Note", output: "count" })).code).toBe("handler_error");
    expect(h.log[0]).toContain("syns.grep");
  });
  it("refuses what the schema bounds, and context under an output that has none, before any process", async () => {
    const h = harness();
    const cases = [{ pattern: "" }, { pattern: "x".repeat(513) }, { pattern: "x", context: 11 }, { pattern: "x", context: -1 }, { pattern: "x", headLimit: 0 }, { pattern: "x", headLimit: 1001 }, { pattern: "x", output: "json" }, { pattern: "x", glob: Array.from({ length: 9 }, () => "*.md") }, { pattern: "x", glob: [""] }, { pattern: "x", output: "files", context: 2 }, {}];
    for (const params of cases) expect(failureOf(await h.call("syns.grep", params)).code, JSON.stringify(params).slice(0, 80)).toBe("invalid_params");
    expect(h.runner.calls).toHaveLength(0);
  });
});

describe("syns.glob paging (D19)", () => {
  const many = (count: number) => ok({ commitSha: HEAD, version: 6, pattern: "**", path: null, truncated: false, matches: Array.from({ length: count }, (_, i) => ({ path: `f${i}`, size: 1, sha: BLOB })) });
  it("pages a long match list: 2,000 by default, with total and nextOffset", async () => {
    const h = harness({ glob: many(4100) });
    const first = resultOf<any>(await h.call("syns.glob", { pattern: "**" }));
    expect(first.matches).toHaveLength(2000);
    expect(first.total).toBe(4100);
    expect(first.nextOffset).toBe(2000);
    const last = resultOf<any>(await h.call("syns.glob", { pattern: "**", offset: 4000 }));
    expect(last.matches.map((match: { path: string }) => match.path)[0]).toBe("f4000");
    expect(last.matches).toHaveLength(100);
    expect(last.nextOffset).toBeNull();
  });
  it("honours a smaller limit, refuses one over 2,000, and never passes either to the CLI", async () => {
    const h = harness({ glob: many(10) });
    const page = resultOf<any>(await h.call("syns.glob", { pattern: "**", offset: 4, limit: 3 }));
    expect(page.matches.map((match: { path: string }) => match.path)).toEqual(["f4", "f5", "f6"]);
    expect(page.nextOffset).toBe(7);
    expect(h.runner.calls[0]!.args).toEqual(["glob", "--json", "--", "**"]);
    expect(failureOf(await h.call("syns.glob", { pattern: "**", limit: 2001 })).code).toBe("invalid_params");
    expect(h.runner.calls).toHaveLength(1);
  });
});

describe("syns.grep under the host's node limit (D19)", () => {
  it("with context, the default headLimit shrinks so a full answer fits 10,000 nodes", async () => {
    const h = harness({ grep: rec("grep.content.ok") });
    await h.call("syns.grep", { pattern: "x", context: 10 });
    const limit = Number(h.runner.calls[0]!.args.find((arg) => arg.startsWith("--head-limit="))!.split("=")[1]);
    expect(limit).toBeLessThan(200);
    expect(limit * (5 + 6 * 10)).toBeLessThanOrEqual(9000);
  });
  it("without context the default stays 200", async () => {
    const h = harness({ grep: rec("grep.content.ok") });
    await h.call("syns.grep", { pattern: "x" });
    expect(h.runner.calls[0]!.args).toContain("--head-limit=200");
  });
  it("refuses a headLimit that could not fit, naming the most that can, before any process runs", async () => {
    const h = harness({ grep: rec("grep.content.ok") });
    const error = failureOf(await h.call("syns.grep", { pattern: "x", context: 10, headLimit: 500 }));
    expect(error.code).toBe("invalid_params");
    expect(error.message).toMatch(/138/);
    expect(h.runner.calls).toHaveLength(0);
  });
  it("files and count outputs keep the full 1,000", async () => {
    const h = harness({ grep: rec("grep.files.ok") });
    expect((await h.call("syns.grep", { pattern: "x", output: "files", headLimit: 1000 })).ok).toBe(true);
  });
});

describe("syns.diff", () => {
  it("without to resolves the head first and passes both versions; without patch no patch text is returned (A21, S1.18)", async () => {
    const h = harness({ repo: rec("repo.ok"), diff: rec("diff.ok") });
    expect(resultOf(await h.call("syns.diff", { from: OLD }))).toEqual({
      from: { version: OLD, number: 4 },
      to: { version: HEAD, number: 6 },
      files: [
        { path: "fixture/a.md", status: "modified" },
        { path: "fixture/b.md", status: "deleted" },
        { path: "fixture/c.md", status: "added" },
      ],
    });
    expect(h.runner.calls.map((call) => call.args)).toEqual([["repo", "--json"], ["diff", `--from=${OLD}`, `--to=${HEAD}`, "--json"]]);
  });
  it("with to is one process, and with patch returns each file's patch (A21)", async () => {
    const h = harness({ diff: rec("diff.ok") });
    const result = resultOf<{ files: { path: string; status: string; patch?: string }[] }>(await h.call("syns.diff", { from: OLD, to: HEAD, patch: true }));
    expect(h.runner.calls.map((call) => call.args)).toEqual([["diff", `--from=${OLD}`, `--to=${HEAD}`, "--json"]]);
    expect(result.files.map((file) => file.status)).toEqual(["modified", "deleted", "added"]);
    expect(result.files[0]!.patch).toContain("+# a, second text");
    expect(Object.keys(result.files[2]!).sort()).toEqual(["patch", "path", "status"]);
  });
  it("passes a status it has not seen on as a string", async () => {
    const h = harness({ diff: ok({ from: { sha: OLD, version: 4 }, to: { sha: HEAD, version: 6 }, files: [{ path: "a.md", status: "renamed", diff: "" }] }) });
    expect(resultOf<{ files: unknown[] }>(await h.call("syns.diff", { from: OLD, to: HEAD })).files).toEqual([{ path: "a.md", status: "renamed" }]);
  });
  it("a version that does not exist is not_found: the CLI answers the 404, and repo then succeeds (A22)", async () => {
    const h = harness({ diff: rec("not-found-404"), repo: rec("repo.ok") });
    expect(failureOf(await h.call("syns.diff", { from: OLD, to: HEAD })).code).toBe("not_found");
  });
  it("a repository with no commit yet has nothing to compare: not_found", async () => {
    const h = harness({ repo: ok({ owner: "o", name: "n", commitSha: null, role: "owner", visibility: "private", fileCount: 0 }) });
    expect(failureOf(await h.call("syns.diff", { from: OLD })).code).toBe("not_found");
    expect(h.runner.calls).toHaveLength(1);
  });
  it("a success without both versions is handler_error (S3.7)", async () => {
    const h = harness({ diff: ok({ from: { sha: OLD, version: 4 }, files: [] }) });
    expect(failureOf(await h.call("syns.diff", { from: OLD, to: HEAD })).code).toBe("handler_error");
  });
  it("refuses a from or to that is not a version, and a call without from", async () => {
    const h = harness();
    for (const params of [{}, { from: "4" }, { from: OLD, to: "--to=1" }, { from: OLD, patch: "yes" }]) expect(failureOf(await h.call("syns.diff", params)).code).toBe("invalid_params");
    expect(h.runner.calls).toHaveLength(0);
  });
});

describe("every read given a version that does not exist answers not_found (A22)", () => {
  const ghost = "0123456789abcdef0123456789abcdef01234567";
  const calls: [string, string, Record<string, unknown>][] = [
    ["syns.read", "read", { path: "README.md", version: ghost }],
    ["syns.glob", "glob", { pattern: "*", version: ghost }],
    ["syns.grep", "grep", { pattern: "x", version: ghost }],
    ["syns.ls", "ls", { version: ghost }],
    ["syns.readMany", "cat", { paths: ["README.md"], version: ghost }],
  ];
  for (const [method, verb, params] of calls) {
    it(method, async () => {
      const h = harness({ [verb]: rec("version-not-found") });
      const error = failureOf(await h.call(method, params));
      expect(error.code).toBe("not_found");
      expect(error).not.toHaveProperty("reason");
    });
  }
});
