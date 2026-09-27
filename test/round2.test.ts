import { describe, expect, it } from "vitest";
import type { RunRequest } from "../src/cli.js";
import { buildDeclaration } from "../src/declaration.js";
import { METHODS } from "../src/methods/index.js";
import { createResolve } from "../src/resolve.js";
import { ok, rec } from "./fake-runner.js";
import { HEAD, OLD, failureOf, harness, resultOf } from "./harness.js";

/** 0.1.1: the field feedback of 2026-09-25 and the measurements of HOST_FACTS §12 (D21, D22, D28, D29). */

const pathOf = (request: RunRequest): string => request.args[request.args.length - 1]!;

describe("syns.edit where old equals new (D21)", () => {
  const newest = (sha: string, number: number) => ok({ data: [{ sha, version: number, parentSha: null, author: "a", createdAt: "2026-09-27T00:00:00Z", filesChanged: [], message: "m", provenance: {} }], limit: 1, offset: 0, total: number });

  it("is a success that changes nothing when base is the head: one history read, no edit", async () => {
    const h = harness({ history: newest(HEAD, 6) });
    const result = resultOf(await h.call("syns.edit", { path: "notes/a.md", old: "same", new: "same", base: HEAD }));
    expect(result).toEqual({ version: HEAD, number: 6, changed: 0 });
    expect(h.runner.calls.map((call) => call.args)).toEqual([["history", "--limit=1", "--json"]]);
  });

  it("is stale_head, with the head as detail, when base has moved", async () => {
    const h = harness({ history: newest(HEAD, 6) });
    const error = failureOf(await h.call("syns.edit", { path: "a.md", old: "x", new: "x", base: OLD }));
    expect(error).toMatchObject({ code: "conflict", reason: "stale_head", detail: { current: HEAD } });
  });

  it("a real edit says how many paths it changed", async () => {
    const h = harness({ edit: rec("write.one.ok") });
    expect(resultOf(await h.call("syns.edit", { path: "a.md", old: "x", new: "y", base: HEAD }))).toEqual({ version: "a".repeat(39) + "1", number: 7, changed: 1 });
  });
});

describe("syns.read trims a window too large for one answer (D22)", () => {
  const line = "x".repeat(400_000);
  const window = (lines: string[], request: RunRequest) =>
    ok({ commitSha: HEAD, version: 6, path: pathOf(request), content: lines.join("\n"), offset: 1, limit: Number(request.args.find((arg) => arg.startsWith("--limit="))!.split("=")[1]), totalLines: 10, size: 4_000_000, sha: "b".repeat(40) });

  it("serves the lines that fit, and limit says how many", async () => {
    const h = harness({ read: (request) => window([line, line, line, line], request) });
    const result = resultOf<{ text: string; limit: number; offset: number }>(await h.call("syns.read", { path: "big.json", limit: 4 }));
    expect(result.limit).toBe(2);
    expect(result.text).toBe(`${line}\n${line}`);
    expect(result.offset).toBe(1);
  });

  it("leaves a window that fits as the CLI gave it", async () => {
    const h = harness({ read: (request) => window(["a", "b"], request) });
    const result = resultOf<{ text: string; limit: number }>(await h.call("syns.read", { path: "a.md", limit: 5 }));
    expect(result).toMatchObject({ text: "a\nb", limit: 5 });
  });

  it("measures the escaped text: a window of quotes is trimmed sooner", async () => {
    const quotes = '"'.repeat(300_000);
    const h = harness({ read: (request) => window([quotes, quotes], request) });
    expect(resultOf<{ limit: number }>(await h.call("syns.read", { path: "q.json", limit: 2 })).limit).toBe(1);
  });

  it("a single line too large for any answer is response_too_large", async () => {
    const h = harness({ read: (request) => window(["y".repeat(1_100_000)], request) });
    expect(failureOf(await h.call("syns.read", { path: "one.json", limit: 1 })).code).toBe("response_too_large");
  });
});

describe("syns.readMany says how large a file it could not serve is (D29)", () => {
  it("too_large carries size and blob", async () => {
    const big = '"'.repeat(600_000);
    const h = harness({ cat: (request) => ok({ commitSha: HEAD, version: 6, path: pathOf(request), content: big, size: 600_000, sha: "c".repeat(40) }) });
    const result = resultOf<{ files: unknown[] }>(await h.call("syns.readMany", { paths: ["board.json"], version: HEAD }));
    expect(result.files).toEqual([{ path: "board.json", error: "too_large", size: 600_000, blob: "c".repeat(40) }]);
  });

  it("not_text carries size and blob, and no bytes (D-088)", async () => {
    const h = harness({ cat: (request) => ok({ commitSha: HEAD, version: 6, path: pathOf(request), contentBase64: "iVBORw0KGgo=", mediaType: "image/png", size: 8, sha: "d".repeat(40) }) });
    const result = resultOf<{ files: unknown[] }>(await h.call("syns.readMany", { paths: ["images/a.png"], version: HEAD }));
    expect(result.files).toEqual([{ path: "images/a.png", error: "not_text", size: 8, blob: "d".repeat(40) }]);
  });
});

describe("syns.history asks for at most 100 (D28)", () => {
  it("accepts 100", async () => {
    const h = harness({ history: rec("history.ok") });
    expect((await h.call("syns.history", { limit: 100 })).ok).toBe(true);
  });
  it("refuses 101 before any process runs", async () => {
    const h = harness({});
    expect(failureOf(await h.call("syns.history", { limit: 101 })).code).toBe("invalid_params");
    expect(h.runner.calls).toHaveLength(0);
  });
});

describe("syns.revert declares only what it can answer (D29, D13)", () => {
  it("declares neither stale_head nor checkout_dirty", () => {
    const declaration = buildDeclaration(METHODS, { agentInstructions: true }) as { methods: { name: string; reasons: Record<string, unknown> }[] };
    const revert = declaration.methods.find((method) => method.name === "syns.revert")!;
    expect(Object.keys(revert.reasons)).not.toContain("stale_head");
    expect(Object.keys(revert.reasons)).not.toContain("checkout_dirty");
    const write = declaration.methods.find((method) => method.name === "syns.write")!;
    expect(Object.keys(write.reasons)).toEqual(expect.arrayContaining(["stale_head", "checkout_dirty"]));
  });
});

describe("a session that no longer exists (D29)", () => {
  it("resolves to nothing, so the call answers no_repo", async () => {
    const resolve = createResolve({
      threads: {
        get: async () => {
          throw new Error("HTTP 404: Thread not found");
        },
      },
      environments: { get: async () => ({}) },
    });
    expect(await resolve("thr_gone")).toBeNull();
  });

  it("any other failure of the read still throws", async () => {
    const resolve = createResolve({
      threads: {
        get: async () => {
          throw new Error("HTTP 500: boom");
        },
      },
      environments: { get: async () => ({}) },
    });
    await expect(resolve("thr_1")).rejects.toThrow("boom");
  });
});
