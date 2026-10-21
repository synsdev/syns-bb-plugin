import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Limits } from "../../src/cli.js";
import hostEntry from "../../src/host-entry.js";
import { serve, type Served } from "../../hosts/claude/process.js";
import { fakeBb } from "../fake-bb.js";
import { alive, fakeSyns, type Logged, type Reply } from "../fake-syns.js";

// The SDK's host bundle loads only inside bb's host worker ("Dynamic require of child_process").
vi.mock("@get-bb/plugin-sdk/host", () => ({ experimental_defineHostEntry: (entry: unknown) => entry }));

/**
 * Row 40 (D-244 §1): one suite, two hosts. The same calls go through bb (the server half, its host call driving the
 * real host half in the SDK's harness, runSyns included) and through Claude Code (the process the Unife Pages daemon
 * POSTs to), against one fake `syns` answering from the recordings. The answers are deep-equal, the runs per call are
 * equal, and the two runs' logs differ only in SYNS_CALLER.
 */

const LIMITS: Limits = { processMs: 20_000, callMs: 1_500, perMachine: 16 };
const SESSION = "aaaaaaaa-1111-2222-3333-444444444444";
const HEAD = "7ca9bc78ba047d9e7798b8d2733c254e24cfc837";

const dir = mkdtempSync(join(tmpdir(), "syns-both-"));
const checkout = join(dir, "checkout");
const syns = fakeSyns(join(dir, "bin"));

/** The daemon's side: POST the call to the process's endpoint, as claude-pages' provider does. */
function post(endpoint: string, call: Record<string, unknown>): Promise<unknown> {
  const [, socketPath, path] = /^unix:(.+?):(\/.*)$/.exec(endpoint)!;
  return new Promise((resolve, reject) => {
    const text = JSON.stringify({ namespace: "syns", ...call });
    const req = http.request({ socketPath, path, method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(text) } }, (res) => {
      let out = "";
      res.setEncoding("utf8");
      res.on("data", (d: string) => (out += d));
      res.on("end", () => resolve(JSON.parse(out)));
    });
    req.on("error", reject);
    req.end(text);
  });
}

let served: Served;
let daemon: http.Server;
let bbInvoke: (call: unknown) => Promise<unknown>;
let host: { experimental_dispose(): Promise<void> };

beforeAll(async () => {
  mkdirSync(join(checkout, "clients", "vela", "crm"), { recursive: true });
  mkdirSync(join(checkout, "vendor", "other"), { recursive: true });
  writeFileSync(join(checkout, ".syns.yaml"), "owner: acme\nname: crm\n");
  writeFileSync(join(checkout, "clients", "vela", "crm", ".syns.yaml"), "holder: acme/crm\npath: clients/vela/crm\n");
  writeFileSync(join(checkout, "vendor", "other", ".syns.yaml"), "owner: other\nname: elsewhere\n");

  // bb: the server half over a host call that runs the real host half in the SDK's harness.
  const { experimental_createHostEntryHarness } = await import("@get-bb/plugin-sdk/testing/host");
  const harness = experimental_createHostEntryHarness(hostEntry as never);
  host = harness;
  const bb = fakeBb({ synsPath: syns.bin }, (method, input, options) => harness.experimental_call(method as never, input as never, { ...(options.signal ? { signal: options.signal as AbortSignal } : {}) }), LIMITS);
  bbInvoke = async (call) => JSON.parse(JSON.stringify(await bb.handlers.threadPagesInvoke!(call)));

  // Claude Code: the process, registered with a stand-in daemon.
  daemon = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const json = (status: number, value: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
      if (req.url === "/v1/daemon") return json(200, { pid: 4242 });
      if (req.method === "POST" && req.url === "/v1/contributors") return json(201, { ok: true });
      json(200, { ok: true });
    });
  });
  await new Promise<void>((resolve) => daemon.listen(join(dir, "control.sock"), () => resolve()));
  served = await serve({ socket: join(dir, "control.sock"), synsPath: syns.bin, agentInstructions: true, log: { info: () => undefined, warn: () => undefined }, everyMs: 50, limits: LIMITS });
});

afterAll(async () => {
  await served?.stop();
  await new Promise<void>((resolve) => daemon.close(() => resolve()));
  await host?.experimental_dispose();
  rmSync(dir, { recursive: true, force: true });
});

const files = (entries: unknown[], deferred: string[] = []) => ({ verb: "cat", stdout: JSON.stringify({ commitSha: HEAD, deferred, files: entries, version: 6 }) });
const listing = (n: number): Reply => ({ verb: "ls", stdout: JSON.stringify({ commitSha: HEAD, version: 6, truncated: false, entries: Array.from({ length: n }, (_, i) => ({ path: `notes/n${String(i).padStart(4, "0")}.md`, type: i % 50 === 0 ? "dir" : "file", size: i % 50 === 0 ? null : i, sha: i % 50 === 0 ? null : "c".repeat(40) })) }) });
const half = "x".repeat(600 * 1024);

interface Case {
  name: string;
  replies: Reply[];
  method: string;
  params?: Record<string, unknown>;
  scope?: string;
  expect: (answer: Record<string, any>) => void;
}

const CASES: Case[] = [
  { name: "repo, unscoped", replies: [{ verb: "repo", recording: "repo.ok" }], method: "syns.repo", expect: (a) => expect(a).toMatchObject({ ok: true, result: { owner: "acme" } }) },
  { name: "repo, scoped", replies: [{ verb: "repo", recording: "repo.within.placed.2d706e8" }], method: "syns.repo", scope: "clients/vela/crm", expect: (a) => expect(a).toMatchObject({ ok: true, result: { holder: "ana-t/r280-build-scratch" } }) },
  { name: "a scoped call outside the repository", replies: [{ verb: "repo", recording: "repo.within.false.2d706e8" }], method: "syns.ls", scope: "vendor/other", expect: (a) => expect(a).toMatchObject({ ok: false, error: { reason: "bad_scope" } }) },
  { name: "readMany, the four entry kinds", replies: [{ verb: "cat", recording: "cat.paths.mixed.2d706e8" }], method: "syns.readMany", params: { paths: ["a.md", "b.md", "logo.png", "gone.md"] }, expect: (a) => expect(a.result.files.map((f: any) => f.error ?? "text")).toEqual(["text", "text", "not_text", "not_found"]) },
  { name: "readMany, a deferral by the CLI", replies: [{ verb: "cat", recording: "cat.paths.cut-after-first.2d706e8" }], method: "syns.readMany", params: { paths: ["a.md", "notes/big.md", "b.md"] }, expect: (a) => expect(a.result.deferred).toEqual(["notes/big.md", "b.md"]) },
  { name: "readMany, a post-cut", replies: [files([{ path: "1.md", content: half, sha: "b".repeat(40), size: half.length }, { path: "2.md", content: half, sha: "b".repeat(40), size: half.length }])], method: "syns.readMany", params: { paths: ["1.md", "2.md"] }, expect: (a) => expect(a.result.deferred).toEqual(["2.md"]) },
  { name: "readMany, a first path past the room", replies: [{ verb: "cat", recording: "cat.paths.first-past.2d706e8" }], method: "syns.readMany", params: { paths: ["notes/big.md", "a.md", "b.md"] }, expect: (a) => expect(a.result.files).toEqual([{ path: "notes/big.md", error: "too_large" }]) },
  { name: "ls, entries, page 1", replies: [listing(2000)], method: "syns.ls", params: { recursive: true }, expect: (a) => expect(a.result).toMatchObject({ total: 2000, nextOffset: 1500 }) },
  { name: "ls, entries, page 2", replies: [listing(2000)], method: "syns.ls", params: { recursive: true, offset: 1500 }, expect: (a) => expect(a.result).toMatchObject({ nextOffset: null }) },
  { name: "ls, lines, page 1", replies: [listing(2000)], method: "syns.ls", params: { recursive: true, format: "lines", limit: 1200 }, expect: (a) => expect(a.result).toMatchObject({ total: 2000, nextOffset: 1200 }) },
  { name: "ls, lines, page 2", replies: [listing(2000)], method: "syns.ls", params: { recursive: true, format: "lines", offset: 1200, limit: 1200 }, expect: (a) => expect(a.result.lines).toHaveLength(800) },
  { name: "write", replies: [{ verb: "write", recording: "write.one.ok" }, { verb: "cat", recording: "cat.ok" }], method: "syns.write", params: { path: "notes/a.md", text: "a", base: HEAD }, expect: (a) => expect(a.ok).toBe(true) },
  { name: "a signed-out repo", replies: [{ verb: "repo", recording: "signed-out.repo" }, { verb: "whoami", recording: "auth-required" }], method: "syns.repo", expect: (a) => expect(a).toMatchObject({ ok: false, error: { reason: "not_logged_in" } }) },
  { name: "a timed-out run", replies: [{ verb: "repo", recording: "repo.ok", sleepMs: 30_000 }], method: "syns.repo", expect: (a) => expect(a).toMatchObject({ ok: false, error: { reason: "timeout" } }) },
];

/** A run's log without the one key the two hosts set differently. */
const withoutCaller = (runs: Logged[]) => runs.map((run) => ({ ...run, env: { ...run.env, SYNS_CALLER: undefined } }));

describe("row 40: the same calls through bb and through Claude Code answer alike", () => {
  for (const one of CASES) {
    it(one.name, async () => {
      syns.answer(one.replies);
      const call = { method: one.method, params: one.params ?? {}, caller: { sessionId: SESSION, scope: one.scope ?? null, workspace: { id: "ws", path: checkout, machine: null } }, requestId: "r1" };

      syns.reset();
      const viaBb = (await bbInvoke(call)) as Record<string, any>;
      const bbRuns = syns.runs();
      const bbPids = syns.pids();

      syns.reset();
      const viaClaude = (await post(served.endpoint, call)) as Record<string, any>;
      const claudeRuns = syns.runs();
      const claudePids = syns.pids();

      one.expect(viaBb);
      expect(viaClaude).toEqual(viaBb);
      expect(claudeRuns.length).toBe(bbRuns.length);
      expect(bbRuns.length).toBeGreaterThan(0);
      expect(withoutCaller(claudeRuns)).toEqual(withoutCaller(bbRuns));
      expect(bbRuns.every((run) => run.env.SYNS_CALLER === "bb-plugin")).toBe(true);
      expect(claudeRuns.every((run) => run.env.SYNS_CALLER === "claude-pages")).toBe(true);
      // No process outlives its call on either host.
      await vi.waitFor(() => expect([...bbPids, ...claudePids].filter(alive)).toEqual([]), { timeout: 3000 });
    }, 15_000);
  }
});
