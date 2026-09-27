import { describe, expect, it } from "vitest";
import type { RunRequest } from "../src/cli.js";
import { ok, rec, timedOut } from "./fake-runner.js";
import { HEAD, OLD, failureOf, harness, resultOf } from "./harness.js";

const pathOf = (request: RunRequest): string => request.args[request.args.length - 1]!;
const file = (request: RunRequest, content = `text of ${pathOf(request)}`) => ok({ commitSha: HEAD, version: 6, path: pathOf(request), content, size: Buffer.byteLength(content), sha: "b".repeat(40) });

interface Result {
  version: string;
  files: { path: string; text?: string; size?: number; blob?: string; error?: string }[];
  deferred: string[];
}

describe("syns.readMany", () => {
  it("without version resolves the head once, first, and reads every path at it (A18, S1.13)", async () => {
    const h = harness({ repo: rec("repo.ok"), cat: (request) => file(request) });
    const result = resultOf<Result>(await h.call("syns.readMany", { paths: ["a.md", "notes/b.md", "c.md"] }));
    expect(h.runner.calls.map((call) => call.args)).toEqual([
      ["repo", "--json"],
      ["cat", `--version=${HEAD}`, "--json", "--", "a.md"],
      ["cat", `--version=${HEAD}`, "--json", "--", "notes/b.md"],
      ["cat", `--version=${HEAD}`, "--json", "--", "c.md"],
    ]);
    expect(result).toEqual({
      version: HEAD,
      files: ["a.md", "notes/b.md", "c.md"].map((path) => ({ path, text: `text of ${path}`, size: Buffer.byteLength(`text of ${path}`), blob: "b".repeat(40) })),
      deferred: [],
    });
  });

  it("with version runs no repo, and answers that version", async () => {
    const h = harness({ cat: (request) => file(request) });
    const result = resultOf<Result>(await h.call("syns.readMany", { paths: ["a.md"], version: OLD }));
    expect(h.runner.calls.map((call) => call.args)).toEqual([["cat", `--version=${OLD}`, "--json", "--", "a.md"]]);
    expect(result.version).toBe(OLD);
  });

  it("returns the others, in order, and not_found for a path missing at the version, as the CLI reports it (A16, S1.16)", async () => {
    const h = harness({ cat: (request) => (pathOf(request) === "nope/missing.md" ? rec("path-not-found-at-version") : file(request)) });
    const result = resultOf<Result>(await h.call("syns.readMany", { paths: ["a.md", "nope/missing.md", "b.md"], version: HEAD }));
    expect(result.files).toEqual([{ path: "a.md", text: "text of a.md", size: 12, blob: "b".repeat(40) }, { path: "nope/missing.md", error: "not_found" }, { path: "b.md", text: "text of b.md", size: 12, blob: "b".repeat(40) }]);
    expect(h.runner.calls.every((call) => call.args[0] === "cat")).toBe(true);
  });

  it("does the same should the CLI answer a missing path with the 404; the 404 rule then costs one repo however many are missing (S3.5)", async () => {
    const h = harness({ repo: rec("repo.ok"), cat: (request) => (pathOf(request).startsWith("missing") ? rec("not-found-404") : file(request)) });
    const result = resultOf<Result>(await h.call("syns.readMany", { paths: ["a.md", "missing-1.md", "b.md", "missing-2.md"], version: HEAD }));
    expect(result.files.map((entry) => entry.error ?? entry.text)).toEqual(["text of a.md", "not_found", "text of b.md", "not_found"]);
    expect(result.files[1]).toEqual({ path: "missing-1.md", error: "not_found" });
    expect(h.runner.calls.filter((call) => call.args[0] === "repo")).toHaveLength(1);
  });

  it("runs at most 8 CLI processes at once for one call (S1.14)", async () => {
    let running = 0;
    let peak = 0;
    const h = harness({
      cat: async (request) => {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise((resolve) => setTimeout(resolve, 2));
        running -= 1;
        return file(request);
      },
    });
    const paths = Array.from({ length: 30 }, (_, i) => `n${i}.md`);
    const result = resultOf<Result>(await h.call("syns.readMany", { paths, version: HEAD }));
    expect(peak).toBe(8);
    expect(result.files.map((entry) => entry.path)).toEqual(paths);
  });

  it("defers what does not fit, never the first, and cuts nothing (A17, S1.15)", async () => {
    const big = "x".repeat(400 * 1024);
    const h = harness({ cat: (request) => file(request, big) });
    const result = resultOf<Result>(await h.call("syns.readMany", { paths: ["1.md", "2.md", "3.md", "4.md"], version: HEAD }));
    expect(result.files.map((entry) => entry.path)).toEqual(["1.md", "2.md"]);
    expect(result.files.every((entry) => entry.text === big)).toBe(true);
    expect(result.deferred).toEqual(["3.md", "4.md"]);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(1024 * 1024 - 512);
  });

  it("counts bytes as the host does: escapes and multi-byte characters", async () => {
    const heavy = "\u0001ż\"".repeat(60 * 1024); // 6 + 2 + 2 bytes each once serialised
    const h = harness({ cat: (request) => file(request, heavy) });
    const result = resultOf<Result>(await h.call("syns.readMany", { paths: ["1.md", "2.md", "3.md"], version: HEAD }));
    expect(result.files).toHaveLength(1);
    expect(result.deferred).toEqual(["2.md", "3.md"]);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(1024 * 1024 - 512);
  });

  it("answers too_large for a file that alone exceeds an empty response, and goes on (S1.15)", async () => {
    const h = harness({ cat: (request) => file(request, pathOf(request) === "huge.md" ? "x".repeat(1024 * 1024) : "small") });
    const result = resultOf<Result>(await h.call("syns.readMany", { paths: ["huge.md", "a.md"], version: HEAD }));
    expect(result.files).toEqual([{ path: "huge.md", error: "too_large", size: 1024 * 1024, blob: "b".repeat(40) }, { path: "a.md", text: "small", size: 5, blob: "b".repeat(40) }]);
    expect(result.deferred).toEqual([]);
  });

  it("answers too_large for a file the host half stopped collecting (S2.16)", async () => {
    const h = harness({ cat: (request) => ({ ...file(request), exitCode: null, stdout: "", overflowed: true }) });
    expect(resultOf<Result>(await h.call("syns.readMany", { paths: ["a.md"], version: HEAD })).files).toEqual([{ path: "a.md", error: "too_large" }]);
  });

  it("answers not_text, with size and blob, for content that is not a string (D29)", async () => {
    const h = harness({ cat: (request) => ok({ commitSha: HEAD, version: 6, path: pathOf(request), content: null, size: 3, sha: "b".repeat(40) }) });
    expect(resultOf<Result>(await h.call("syns.readMany", { paths: ["a.png"], version: HEAD })).files).toEqual([{ path: "a.png", error: "not_text", size: 3, blob: "b".repeat(40) }]);
  });

  it("fails as a whole for a reason that applies to every path (S1.16)", async () => {
    const version = harness({ cat: rec("version-not-found") });
    expect(failureOf(await version.call("syns.readMany", { paths: ["a.md", "b.md"], version: OLD })).code).toBe("not_found");
    const access = harness({ cat: rec("not-found-404"), repo: rec("not-found-404") });
    expect(failureOf(await access.call("syns.readMany", { paths: ["a.md"], version: OLD }))).toMatchObject({ code: "unavailable", reason: "no_access" });
    const slow = harness({ cat: (request) => (pathOf(request) === "b.md" ? timedOut() : file(request)) });
    expect(failureOf(await slow.call("syns.readMany", { paths: ["a.md", "b.md"], version: OLD }))).toMatchObject({ code: "unavailable", reason: "timeout" });
    const empty = harness({ repo: ok({ owner: "o", name: "n", commitSha: null, role: "owner", visibility: "private", fileCount: 0 }) });
    expect(failureOf(await empty.call("syns.readMany", { paths: ["a.md"] })).code).toBe("not_found");
  });

  it("refuses no path, more than 64, and the same path twice, before any process", async () => {
    const h = harness();
    for (const paths of [[], Array.from({ length: 65 }, (_, i) => `${i}.md`), ["a.md", "b.md", "a.md"]]) {
      expect(failureOf(await h.call("syns.readMany", { paths, version: HEAD })).code).toBe("invalid_params");
    }
    expect(h.runner.calls).toHaveLength(0);
  });
});
