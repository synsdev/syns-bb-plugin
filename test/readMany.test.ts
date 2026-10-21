import { describe, expect, it } from "vitest";
import type { RunRequest, RunResult } from "../src/cli.js";
import { ok, rec, spawnFailed, timedOut } from "./fake-runner.js";
import { HEAD, OLD, failureOf, harness, resultOf } from "./harness.js";

/**
 * 0.9 (roadmap 280, D-244): syns.readMany is one `syns cat --json --paths-from=- --max-bytes=<room>` run. The CLI's
 * `files` answer (syns-cli 2d706e8, HOST_FACTS pass "CLI at syns-cli 2d706e8") is mapped in request order; the
 * plugin keeps only its post-cut by the text as JSON escapes it (S1.15).
 */

interface Result {
  version: string;
  files: { path: string; text?: string; size?: number; blob?: string | null; error?: string }[];
  deferred: string[];
}

const M1 = 1024 * 1024;
/** The room 0.8.7 computes, with a 40-character version. */
const roomOf = (paths: string[]): number => M1 - 1024 - Buffer.byteLength(JSON.stringify({ version: "x".repeat(40), files: [], deferred: paths }));
const BLOB = "b".repeat(40);

type Entry = { path: string; content?: string; contentBase64?: string; sha?: string; size?: number; error?: { code: string; message: string } };
/** A `files` answer the way the CLI writes it. */
const files = (entries: Entry[], deferred: string[] = [], commitSha = HEAD): RunResult => ok({ commitSha, deferred, files: entries, version: 6 });
const text = (path: string, content = `text of ${path}`): Entry => ({ path, content, sha: BLOB, size: Buffer.byteLength(content) });
/** Every path of the run's standard input, read as text. */
const allText = (content?: (path: string) => string) => (request: RunRequest) => files(pathsOf(request).map((path) => text(path, content?.(path))));
const pathsOf = (request: RunRequest): string[] => (request.stdin ?? "").split("\n").filter(Boolean);

describe("syns.readMany: one run (rows 1, 2)", () => {
  it("16 paths without version: exactly one runner call, the paths on standard input, no repo and no --version (row 1)", async () => {
    const paths = Array.from({ length: 16 }, (_, i) => `notes/n${String(i).padStart(2, "0")}.md`);
    const h = harness({ cat: allText() });
    const result = resultOf<Result>(await h.call("syns.readMany", { paths }));
    expect(h.runner.calls).toHaveLength(1);
    expect(h.runner.calls[0]!.args).toEqual(["cat", "--paths-from=-", `--max-bytes=${roomOf(paths)}`, "--json"]);
    expect(h.runner.calls[0]!.stdin).toBe(`${paths.join("\n")}\n`);
    expect(result.version).toBe(HEAD);
    expect(result.files.map((entry) => entry.path)).toEqual(paths);
    expect(result.deferred).toEqual([]);
  });

  it("with version V: --version=V first, and the answer's version is the CLI's commitSha (row 2)", async () => {
    const h = harness({ cat: (request) => files(pathsOf(request).map((path) => text(path)), [], OLD) });
    const result = resultOf<Result>(await h.call("syns.readMany", { paths: ["a.md"], version: OLD }));
    expect(h.runner.calls.map((call) => call.args)).toEqual([["cat", `--version=${OLD}`, "--paths-from=-", `--max-bytes=${roomOf(["a.md"])}`, "--json"]]);
    expect(result.version).toBe(OLD);
  });

  it("the recorded pinned answer: one run, the texts at that commit (row 2)", async () => {
    const at = "46caab7a2ca69527d3a2367b33de371fd0f8dce5";
    const h = harness({ cat: rec("cat.paths.pinned.2d706e8") });
    const result = resultOf<Result>(await h.call("syns.readMany", { paths: ["a.md", "b.md"], version: at }));
    expect(result.version).toBe(at);
    expect(result.files.map((entry) => entry.text)).toEqual(["# a\nalpha\n", 'b "quoted" text ż\n']);
    expect(h.runner.calls).toHaveLength(1);
  });

  it("the answer's version is the CLI's commitSha, not the version asked (row 2)", async () => {
    const h = harness({ cat: (request) => files(pathsOf(request).map((path) => text(path)), [], HEAD) });
    expect(resultOf<Result>(await h.call("syns.readMany", { paths: ["a.md"], version: OLD })).version).toBe(HEAD);
  });
});

describe("syns.readMany: the mapping, in request order (row 3)", () => {
  it("Q-0155's sample, on the CLI's recorded answer: a text, a text, a picture, a missing path", async () => {
    const h = harness({ cat: rec("cat.paths.mixed.2d706e8") });
    const result = resultOf<Result>(await h.call("syns.readMany", { paths: ["a.md", "b.md", "logo.png", "gone.md"] }));
    expect(result).toEqual({
      version: "46caab7a2ca69527d3a2367b33de371fd0f8dce5",
      deferred: [],
      files: [
        { path: "a.md", text: "# a\nalpha\n", size: 10, blob: "51ec0f70d7b49104445405f0e9038808ce64b4b7" },
        { path: "b.md", text: 'b "quoted" text ż\n', size: 19, blob: "49c2765f185c347900abe29abb10823efa6baa11" },
        { path: "logo.png", error: "not_text", size: 268, blob: "2d36779307198d52711e378a1f3df81bb0d9d029" },
        { path: "gone.md", error: "not_found" },
      ],
    });
    expect(h.runner.calls).toHaveLength(1);
  });

  it("maps by path, in the order asked, whatever order the CLI wrote its entries in", async () => {
    const h = harness({ cat: () => files([text("b.md"), { path: "a.md", error: { code: "NOT_FOUND", message: "path not found at version 6: a.md" } }]) });
    expect(resultOf<Result>(await h.call("syns.readMany", { paths: ["a.md", "b.md"] })).files.map((entry) => entry.path)).toEqual(["a.md", "b.md"]);
  });
});

describe("syns.readMany: deferral (rows 4–7)", () => {
  it("the CLI's deferred paths follow the plugin's own, in request order, with no second run (row 4)", async () => {
    const h = harness({ cat: rec("cat.paths.cut-after-first.2d706e8") });
    const result = resultOf<Result>(await h.call("syns.readMany", { paths: ["a.md", "notes/big.md", "b.md"] }));
    expect(result.files).toEqual([{ path: "a.md", text: "# a\nalpha\n", size: 10, blob: "51ec0f70d7b49104445405f0e9038808ce64b4b7" }]);
    expect(result.deferred).toEqual(["notes/big.md", "b.md"]);
    expect(h.runner.calls).toHaveLength(1);
  });

  it("the post-cut: the CLI served every text, the plugin defers what its escaped bytes do not fit, never the first (row 5, A17, S1.15)", async () => {
    const big = "x".repeat(400 * 1024);
    const h = harness({ cat: allText(() => big) });
    const result = resultOf<Result>(await h.call("syns.readMany", { paths: ["1.md", "2.md", "3.md", "4.md"] }));
    expect(result.files.map((entry) => entry.path)).toEqual(["1.md", "2.md"]);
    expect(result.files.every((entry) => entry.text === big)).toBe(true);
    expect(result.deferred).toEqual(["3.md", "4.md"]);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(M1 - 512);
  });

  it("counts bytes as the host does: escapes and multi-byte characters (row 5)", async () => {
    const heavy = "\u0001ż\"".repeat(60 * 1024); // 6 + 2 + 2 bytes each once serialised
    const h = harness({ cat: allText(() => heavy) });
    const result = resultOf<Result>(await h.call("syns.readMany", { paths: ["1.md", "2.md", "3.md"] }));
    expect(result.files).toHaveLength(1);
    expect(result.deferred).toEqual(["2.md", "3.md"]);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(M1 - 512);
  });

  it("the plugin's deferred paths come before the CLI's (rows 4, 5)", async () => {
    const half = "x".repeat(600 * 1024);
    const h = harness({ cat: () => files([text("1.md", half), text("2.md", half)], ["3.md", "4.md"]) });
    // 2.md fits the room alone, but not what is left after 1.md: it waits, before the CLI's own.
    const result = resultOf<Result>(await h.call("syns.readMany", { paths: ["1.md", "2.md", "3.md", "4.md"] }));
    expect(result.files.map((entry) => entry.path)).toEqual(["1.md"]);
    expect(result.deferred).toEqual(["2.md", "3.md", "4.md"]);
  });

  it("a first path whose escaped text alone passes the room is too_large with size and blob, and the call goes on (row 6)", async () => {
    const h = harness({ cat: allText((path) => (path === "huge.md" ? "\u0001".repeat(200 * 1024) : "small")) });
    const result = resultOf<Result>(await h.call("syns.readMany", { paths: ["huge.md", "a.md"] }));
    expect(result.files).toEqual([{ path: "huge.md", error: "too_large", size: 200 * 1024, blob: BLOB }, { path: "a.md", text: "small", size: 5, blob: BLOB }]);
    expect(result.deferred).toEqual([]);
  });

  it("a first path the CLI deferred is too_large with no size or blob, and every later path is deferred (row 7, recorded)", async () => {
    const h = harness({ cat: rec("cat.paths.first-past.2d706e8") });
    const result = resultOf<Result>(await h.call("syns.readMany", { paths: ["notes/big.md", "a.md", "b.md"] }));
    expect(result.files).toEqual([{ path: "notes/big.md", error: "too_large" }]);
    expect(result.deferred).toEqual(["a.md", "b.md"]);
    expect(h.runner.calls).toHaveLength(1);
  });

  it("so does a picture the CLI deferred first: too_large, not not_text (row 7, Known issue 4)", async () => {
    const h = harness({ cat: () => files([], ["photo.png", "a.md"]) });
    expect(resultOf<Result>(await h.call("syns.readMany", { paths: ["photo.png", "a.md"] })).files).toEqual([{ path: "photo.png", error: "too_large" }]);
  });
});

describe("syns.readMany: failures (rows 8, 9, 10)", () => {
  for (const code of ["ENGINE_BUSY", "SERVER_UNREACHABLE", "RATE_LIMITED", "INTERNAL_ERROR", "RESPONSE_UNDECODABLE", "VALIDATION_ERROR", "CONFIG_ERROR", "CHUNK_GIVEN_UP"]) {
    it(`a per-file ${code} fails the call as handler_error in the entry's words, logged without the path (row 8)`, async () => {
      const message = `${code.toLowerCase()}: the read of /work/checkout/secret/a.md at /Users/reader/x failed`;
      const h = harness({ cat: () => files([text("a.md"), { path: "secret/b.md", error: { code, message } }]) });
      const error = failureOf(await h.call("syns.readMany", { paths: ["a.md", "secret/b.md"] }));
      expect(error).toEqual({ code: "handler_error", message: `${code.toLowerCase()}: the read of ./secret/a.md at <path> failed` });
      expect(h.log.some((line) => line.includes(`readMany per-file ${code}`))).toBe(true);
      expect(h.log.join("\n")).not.toContain("secret/b.md");
    });
  }

  it("a per-file message is cut at 300 characters (row 8)", async () => {
    const h = harness({ cat: () => files([{ path: "a.md", error: { code: "INTERNAL_ERROR", message: "y".repeat(400) } }]) });
    expect(failureOf(await h.call("syns.readMany", { paths: ["a.md"] })).message).toHaveLength(300);
  });

  it("an unknown version is not_found, from the recorded refusal (row 9)", async () => {
    const h = harness({ cat: rec("cat.paths.unknown-version.2d706e8") });
    expect(failureOf(await h.call("syns.readMany", { paths: ["a.md", "b.md"], version: OLD })).code).toBe("not_found");
    expect(h.runner.calls).toHaveLength(1);
  });

  it("a 404 runs S3.5's repo once, then whoami; signed out is not_logged_in (row 9)", async () => {
    const h = harness({ cat: rec("not-found-404"), repo: rec("signed-out.repo"), whoami: rec("auth-required") });
    expect(failureOf(await h.call("syns.readMany", { paths: ["a.md"] }))).toMatchObject({ code: "unavailable", reason: "not_logged_in" });
    expect(h.runner.calls.map((call) => call.args[0])).toEqual(["cat", "repo", "whoami"]);
    const access = harness({ whoami: rec("whoami.ok"), cat: rec("not-found-404"), repo: rec("not-found-404") });
    expect(failureOf(await access.call("syns.readMany", { paths: ["a.md"], version: OLD }))).toMatchObject({ code: "unavailable", reason: "no_access" });
  });

  it("cli_missing and timeout as today (row 9)", async () => {
    expect(failureOf(await harness({ cat: spawnFailed("cli_not_found") }).call("syns.readMany", { paths: ["a.md"] }))).toMatchObject({ reason: "cli_missing" });
    expect(failureOf(await harness({ cat: timedOut() }).call("syns.readMany", { paths: ["a.md"] }))).toMatchObject({ reason: "timeout" });
  });

  it("an older CLI's real refusal of --paths-from comes back in its own words, not cli_too_old (row 10, recorded on 0.3.22)", async () => {
    const h = harness({ cat: rec("cat.paths-from.0322") });
    const error = failureOf(await h.call("syns.readMany", { paths: ["a.md"] }));
    expect(error).toEqual({ code: "handler_error", message: "error: unexpected argument '--paths-from' found" });
    expect(h.runner.calls).toHaveLength(1);
  });

  it("an empty repository's refusal is the CLI's, whatever it maps to (row 12, Known issue 6)", async () => {
    const h = harness({ cat: rec("server-422") });
    expect(failureOf(await h.call("syns.readMany", { paths: ["a.md"] }))).toEqual({ code: "handler_error", message: "server error (422): validation_error" });
  });
});

describe("syns.readMany: kept (row 11)", () => {
  it("refuses no path, more than 64, and the same path twice, before any process", async () => {
    const h = harness();
    for (const paths of [[], Array.from({ length: 65 }, (_, i) => `${i}.md`), ["a.md", "b.md", "a.md"]]) {
      expect(failureOf(await h.call("syns.readMany", { paths, version: HEAD })).code).toBe("invalid_params");
    }
    expect(h.runner.calls).toHaveLength(0);
  });

  it("a CLI answer with a hole is handler_error, never a result with one (S3.7)", async () => {
    const h = harness({ cat: () => ok({ deferred: [], files: [text("a.md")], version: 6 }) });
    expect(failureOf(await h.call("syns.readMany", { paths: ["a.md"] })).code).toBe("handler_error");
  });

  it("a CLI answer that leaves a path out is handler_error", async () => {
    const h = harness({ cat: () => files([text("a.md")]) });
    expect(failureOf(await h.call("syns.readMany", { paths: ["a.md", "b.md"] })).code).toBe("handler_error");
  });

  it("maxResponseBytes stays 1 MiB", async () => {
    const { readMany } = await import("../src/methods/readMany.js");
    expect(readMany.maxResponseBytes).toBe(M1);
  });
});
