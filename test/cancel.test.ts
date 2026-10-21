import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createCli, type RunRequest, type RunResult } from "../src/cli.js";
import { createHostRunner } from "../src/host-runner.js";
import hostEntry from "../src/host-entry.js";
import { runSyns } from "../src/syns-process.js";
import { createLocalRunner } from "../hosts/claude/runner.js";
import { alive, fakeSyns } from "./fake-syns.js";
import { rec } from "./fake-runner.js";
import { FAST, failureOf, harness } from "./harness.js";

// The SDK's host bundle loads only inside bb's host worker ("Dynamic require of child_process").
vi.mock("@get-bb/plugin-sdk/host", () => ({ experimental_defineHostEntry: (entry: unknown) => entry }));

/** 0.9 (roadmap 280): the 25 s limit stops the call's run, on both hosts (rows 27–32). */

const where = { hostId: "host_1", cwd: "/work" };
const done: RunResult = { exitCode: 0, stdout: "{}", stderr: "", timedOut: false, spawnError: null, overflowed: false };

describe("dispatch: one AbortController per call (row 27)", () => {
  it("the signal reaches every run of the call: the scope check, the method's run, S3.5's repo and whoami; the call's end aborts it", async () => {
    const h = harness({ repo: (request) => (request.args.includes("--within=/work/checkout") ? rec("not-found-404") : rec("not-found-404")), whoami: rec("whoami.ok") });
    await h.invoke({ method: "syns.readMany", params: { paths: ["a.md"] }, caller: { sessionId: "thr_page", scope: "clients/vela" }, requestId: "r" });
    const signals = h.runner.calls.map((call) => call.signal);
    expect(h.runner.calls.map((call) => call.args[0])).toEqual(["repo", "whoami"]);
    expect(signals.every((signal) => signal instanceof AbortSignal)).toBe(true);
    expect(new Set(signals).size).toBe(1);
    expect(signals[0]!.aborted).toBe(true);
  });

  it("every run of a call holds the same signal, method run and the 404 rule's repo and whoami", async () => {
    const h = harness({ cat: rec("not-found-404"), repo: rec("not-found-404"), whoami: rec("whoami.ok") });
    await h.call("syns.readMany", { paths: ["a.md"] });
    expect(h.runner.calls.map((call) => call.args[0])).toEqual(["cat", "repo", "whoami"]);
    expect(new Set(h.runner.calls.map((call) => call.signal)).size).toBe(1);
  });

  it("the call limit aborts the signal of a run still going, and the call answers timeout", async () => {
    let seen: AbortSignal | undefined;
    const h = harness({
      repo: (request) =>
        new Promise<RunResult>((resolve) => {
          seen = request.signal;
          request.signal?.addEventListener("abort", () => resolve({ ...done, exitCode: null, timedOut: true }));
        }),
    });
    const started = Date.now();
    expect(failureOf(await h.call("syns.repo"))).toMatchObject({ reason: "timeout" });
    expect(Date.now() - started).toBeLessThan(FAST.callMs + 40);
    expect(seen?.aborted).toBe(true);
  });

  it("each call has its own controller", async () => {
    const h = harness({ repo: rec("repo.ok") });
    await h.call("syns.repo");
    await h.call("syns.repo");
    expect(h.runner.calls[0]!.signal).not.toBe(h.runner.calls[1]!.signal);
  });
});

describe("cli.run and the queue (rows 28, 29)", () => {
  it("with perMachine full, an aborted call's queued run leaves the queue: timedOut, no runner call, no slot, the next in line not skipped (row 28)", async () => {
    const started: string[] = [];
    let release!: () => void;
    const runner = {
      async run(request: RunRequest): Promise<RunResult> {
        started.push(request.args[0]!);
        if (request.args[0] === "first") await new Promise<void>((resolve) => (release = resolve));
        return done;
      },
    };
    const cli = createCli(runner, { ...FAST, callMs: 5000, processMs: 5000, perMachine: 1 });
    const deadline = Date.now() + 5000;
    const first = cli.run(where, ["first"], undefined, deadline);
    const controller = new AbortController();
    const second = cli.run(where, ["second"], undefined, deadline, undefined, controller.signal);
    const third = cli.run(where, ["third"], undefined, deadline);
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();
    expect(await second).toMatchObject({ timedOut: true, exitCode: null });
    expect(started).toEqual(["first"]);
    release();
    expect((await first).exitCode).toBe(0);
    expect((await third).exitCode).toBe(0);
    expect(started).toEqual(["first", "third"]);
    // No slot was lost or taken twice: one more run gets its turn at once.
    expect((await cli.run(where, ["fourth"], undefined, Date.now() + 1000)).exitCode).toBe(0);
  });

  it("no run starts on an aborted signal (row 29)", async () => {
    const calls: RunRequest[] = [];
    const cli = createCli({ run: async (request) => (calls.push(request), done) }, FAST);
    const controller = new AbortController();
    controller.abort();
    expect(await cli.run(where, ["repo", "--json"], undefined, Date.now() + 1000, undefined, controller.signal)).toMatchObject({ timedOut: true });
    expect(calls).toHaveLength(0);
  });

  it("the signal is handed to the runner with the request", async () => {
    const calls: RunRequest[] = [];
    const cli = createCli({ run: async (request) => (calls.push(request), done) }, FAST);
    const controller = new AbortController();
    await cli.run(where, ["repo", "--json"], undefined, Date.now() + 1000, undefined, controller.signal);
    expect(calls[0]!.signal).toBe(controller.signal);
  });
});

describe("bb's runner (row 30)", () => {
  it("passes the request's signal in host.call's options for run, stdinPart and outputPart", async () => {
    const seen: { method: string; options: Record<string, unknown> }[] = [];
    const big = "x".repeat(9 * 1024 * 1024);
    const runner = createHostRunner(async (method, _input, options) => {
      seen.push({ method, options: options as Record<string, unknown> });
      if (method === "stdinPart") return { received: 1 };
      if (method === "outputPart") return { chunk: "y", done: true, lost: false };
      return { ...done, stdout: "x", rest: { id: "a", length: 2 } };
    }, async () => undefined);
    const controller = new AbortController();
    await runner.run({ hostId: "h", cwd: "/w", args: ["write"], stdinBase64: Buffer.from(big).toString("base64"), timeoutMs: 1000, signal: controller.signal });
    expect(new Set(seen.map((one) => one.method))).toEqual(new Set(["stdinPart", "run", "outputPart"]));
    for (const one of seen) expect(one.options.signal, one.method).toBe(controller.signal);
  });

  it("a host call that rejects because the signal aborted answers timedOut, not spawnError", async () => {
    const controller = new AbortController();
    const runner = createHostRunner(
      (_method, _input, options) =>
        new Promise((_, reject) => {
          if (options.signal?.aborted) reject(new Error("The operation was aborted"));
          options.signal?.addEventListener("abort", () => reject(new Error("The operation was aborted")));
        }),
      async () => undefined,
    );
    const pending = runner.run({ hostId: "h", cwd: "/w", args: ["repo", "--json"], timeoutMs: 1000, signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();
    expect(await pending).toMatchObject({ timedOut: true, spawnError: null });
  });

  it("a host call that fails for another reason stays a spawn error", async () => {
    const runner = createHostRunner(async () => {
      throw new Error("machine unreachable");
    }, async () => undefined);
    expect((await runner.run({ hostId: "h", cwd: "/w", args: ["repo", "--json"], timeoutMs: 1000, signal: new AbortController().signal })).spawnError).toMatch(/machine unreachable/);
  });
});

describe("runSyns and the hosts' runners on abort (rows 31, 32)", () => {
  const dir = mkdtempSync(join(tmpdir(), "syns-cancel-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const syns = fakeSyns(join(dir, "bin"));
  syns.answer([{ verb: "repo", sleepMs: 30_000, recording: "repo.ok" }]);

  it("stops the process within 100 ms of the abort, as at its time limit, and answers timedOut (row 32)", async () => {
    syns.reset();
    const controller = new AbortController();
    const pending = runSyns(syns.bin, ["repo", "--json"], dir, undefined, 20_000, controller.signal, "bb-plugin");
    await vi.waitFor(() => expect(syns.pids()).toHaveLength(1), { timeout: 5000 });
    const at = Date.now();
    controller.abort();
    const result = await pending;
    expect(Date.now() - at).toBeLessThan(100);
    expect(result).toMatchObject({ timedOut: true, spawnError: null, exitCode: null });
    await vi.waitFor(() => expect(alive(syns.pids()[0]!)).toBe(false), { timeout: 2000 });
  });

  it("a signal already aborted starts no process (row 32)", async () => {
    syns.reset();
    const controller = new AbortController();
    controller.abort();
    expect(await runSyns(syns.bin, ["repo", "--json"], dir, undefined, 20_000, controller.signal, "bb-plugin")).toMatchObject({ timedOut: true, spawnError: null });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(syns.runs()).toEqual([]);
  });

  it("the signal is not handed to spawn: no SIGTERM ending as spawnError (row 32)", async () => {
    const text = (await import("node:fs")).readFileSync(new URL("../src/syns-process.ts", import.meta.url), "utf8");
    const spawnCall = /spawn\(([^)]*)\)/.exec(text)![1]!;
    expect(spawnCall).not.toMatch(/signal/);
  });

  it("Claude Code: createLocalRunner passes the request's signal to runSyns (row 31)", async () => {
    syns.reset();
    const controller = new AbortController();
    const pending = createLocalRunner(syns.bin).run({ hostId: "local", cwd: dir, args: ["repo", "--json"], timeoutMs: 20_000, signal: controller.signal });
    await vi.waitFor(() => expect(syns.pids()).toHaveLength(1), { timeout: 5000 });
    controller.abort();
    expect(await pending).toMatchObject({ timedOut: true });
    await vi.waitFor(() => expect(alive(syns.pids()[0]!)).toBe(false), { timeout: 2000 });
  });

  it("bb: the host context's own signal aborting does the same (row 32)", async () => {
    syns.reset();
    const { experimental_createHostEntryHarness } = await import("@get-bb/plugin-sdk/testing/host");
    const host = experimental_createHostEntryHarness(hostEntry as never);
    const controller = new AbortController();
    const pending = host.experimental_call("run", { cwd: dir, args: ["repo", "--json"], timeoutMs: 20_000, synsPath: syns.bin }, { signal: controller.signal });
    await vi.waitFor(() => expect(syns.pids()).toHaveLength(1), { timeout: 5000 });
    const at = Date.now();
    controller.abort();
    expect(await pending).toMatchObject({ timedOut: true, spawnError: null });
    expect(Date.now() - at).toBeLessThan(100);
    await vi.waitFor(() => expect(alive(syns.pids()[0]!)).toBe(false), { timeout: 2000 });
    await host.experimental_dispose();
  });
});
