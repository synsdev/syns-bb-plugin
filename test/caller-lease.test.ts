import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runSyns } from "../src/syns-process.js";
import { createLocalRunner } from "../hosts/claude/runner.js";
import { fakeSyns } from "./fake-syns.js";

// The SDK's host bundle loads only inside bb's host worker ("Dynamic require of child_process").
vi.mock("@get-bb/plugin-sdk/host", () => ({ experimental_defineHostEntry: (entry: unknown) => entry }));

/** 0.9 (roadmap 280): each host names itself in SYNS_CALLER (rows 33, 34); bb holds its worker (rows 35, 36). */

const dir = mkdtempSync(join(tmpdir(), "syns-caller-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const syns = fakeSyns(join(dir, "bin"));
syns.answer([{ verb: "repo", recording: "repo.ok" }, { verb: "place", recording: "place.ok" }]);

type Run = (input: Record<string, unknown>, context: Record<string, unknown>) => Promise<Record<string, unknown>>;
/** A fresh host entry, its lease and timer its own. */
const freshEntry = async () => {
  vi.resetModules();
  return (await import("../src/host-entry.js")).default as unknown as { contract: unknown; handlers: { run: Run } };
};
const context = (extra: Record<string, unknown> = {}) => ({ signal: new AbortController().signal, lifecycle: { signal: new AbortController().signal }, ...extra });

describe("SYNS_CALLER (rows 33, 34)", () => {
  const inherited = process.env.SYNS_CALLER;
  beforeEach(() => {
    syns.reset();
    process.env.SYNS_CALLER = "inherited-name";
  });
  afterEach(() => {
    if (inherited === undefined) delete process.env.SYNS_CALLER;
    else process.env.SYNS_CALLER = inherited;
  });

  it("runSyns sets the caller's name over an inherited one, and the provenance cannot set it", async () => {
    await runSyns(syns.bin, ["repo", "--json"], dir, undefined, 5000, new AbortController().signal, "bb-plugin", { SYNS_INTEGRATION: "syns-pages", SYNS_RUN: "thr_1", SYNS_TRIGGER: "page", SYNS_CALLER: "page-chose" });
    expect(syns.runs()[0]!.env).toMatchObject({ SYNS_CALLER: "bb-plugin", SYNS_INTEGRATION: "syns-pages" });
  });

  it("bb: every process the host half starts has SYNS_CALLER=bb-plugin, over an inherited one (row 33)", async () => {
    const entry = await freshEntry();
    await entry.handlers.run({ cwd: dir, args: ["repo", "--json"], timeoutMs: 5000, synsPath: syns.bin }, context());
    await entry.handlers.run({ cwd: dir, args: ["place", "--json"], env: { SYNS_INTEGRATION: "syns-pages", SYNS_RUN: "thr_1", SYNS_TRIGGER: "page" }, timeoutMs: 5000, synsPath: syns.bin }, context());
    expect(syns.runs().map((run) => run.env.SYNS_CALLER)).toEqual(["bb-plugin", "bb-plugin"]);
    expect(syns.runs()[1]!.env).toMatchObject({ SYNS_INTEGRATION: "syns-pages", SYNS_RUN: "thr_1", SYNS_TRIGGER: "page" });
  });

  it("bb: the host contract's provenance holds exactly its three keys, so a page cannot set SYNS_CALLER (row 33)", async () => {
    const { hostContract } = await import("../src/contract.js");
    const input = (hostContract.run as { input: { safeParse(v: unknown): { success: boolean } } }).input;
    expect(input.safeParse({ cwd: "/w", args: ["place"], timeoutMs: 1000, env: { SYNS_INTEGRATION: "a", SYNS_RUN: "b", SYNS_TRIGGER: "c", SYNS_CALLER: "x" } }).success).toBe(false);
  });

  it("Claude Code: every process the runner starts has SYNS_CALLER=claude-pages, with the same precedence (row 34)", async () => {
    const runner = createLocalRunner(syns.bin);
    await runner.run({ hostId: "local", cwd: dir, args: ["repo", "--json"], timeoutMs: 5000 });
    await runner.run({ hostId: "local", cwd: dir, args: ["place", "--json"], env: { SYNS_INTEGRATION: "syns-pages", SYNS_RUN: "thr_1", SYNS_TRIGGER: "page", SYNS_CALLER: "page-chose" } as never, timeoutMs: 5000 });
    expect(syns.runs().map((run) => run.env.SYNS_CALLER)).toEqual(["claude-pages", "claude-pages"]);
  });
});

describe("bb's worker lease (rows 35, 36)", () => {
  afterEach(() => vi.useRealTimers());
  const MINUTE = 60_000;

  it("0 → 1 → 1 → 0 → 1: a run takes one, the next finds it, 15 minutes after the last the lease goes, a later run takes a new one (row 35)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const entry = await freshEntry();
    const { experimental_createHostEntryHarness } = await import("@get-bb/plugin-sdk/testing/host");
    const host = experimental_createHostEntryHarness(entry as never);
    const run = () => host.experimental_call("run", { cwd: dir, args: ["repo", "--json"], timeoutMs: 5000, synsPath: syns.bin });
    expect(host.experimental_getRetainedWorkerLeaseCount()).toBe(0);
    await run();
    expect(host.experimental_getRetainedWorkerLeaseCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    await run();
    expect(host.experimental_getRetainedWorkerLeaseCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(15 * MINUTE - 1);
    expect(host.experimental_getRetainedWorkerLeaseCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(host.experimental_getRetainedWorkerLeaseCount()).toBe(0);
    await run();
    expect(host.experimental_getRetainedWorkerLeaseCount()).toBe(1);
    await host.experimental_dispose();
  });

  it("the timer starts only when the last active run ends (row 35)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const entry = await freshEntry();
    const { experimental_createHostEntryHarness } = await import("@get-bb/plugin-sdk/testing/host");
    const host = experimental_createHostEntryHarness(entry as never);
    syns.answer([{ verb: "repo", recording: "repo.ok" }, { verb: "slow", recording: "repo.ok", sleepMs: 300 }]);
    const slow = host.experimental_call("run", { cwd: dir, args: ["slow"], timeoutMs: 5000, synsPath: syns.bin });
    await host.experimental_call("run", { cwd: dir, args: ["repo", "--json"], timeoutMs: 5000, synsPath: syns.bin });
    // One run ended, one is still running: the only timer is the running process's own limit, no hold yet.
    expect(vi.getTimerCount()).toBe(1);
    expect(host.experimental_getRetainedWorkerLeaseCount()).toBe(1);
    await slow;
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(15 * MINUTE - 1);
    expect(host.experimental_getRetainedWorkerLeaseCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(host.experimental_getRetainedWorkerLeaseCount()).toBe(0);
    syns.answer([{ verb: "repo", recording: "repo.ok" }, { verb: "place", recording: "place.ok" }]);
    await host.experimental_dispose();
  });

  it("a run at the expiry finds the lease or none, and either way one is held after it (row 35)", async () => {
    for (const order of ["expiry first", "run first"]) {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const entry = await freshEntry();
      const { experimental_createHostEntryHarness } = await import("@get-bb/plugin-sdk/testing/host");
      const host = experimental_createHostEntryHarness(entry as never);
      const run = () => host.experimental_call("run", { cwd: dir, args: ["repo", "--json"], timeoutMs: 5000, synsPath: syns.bin });
      await run();
      await vi.advanceTimersByTimeAsync(15 * MINUTE - 1);
      if (order === "expiry first") {
        await vi.advanceTimersByTimeAsync(1);
        await run();
      } else {
        const pending = run();
        await vi.advanceTimersByTimeAsync(1);
        await pending;
      }
      expect(host.experimental_getRetainedWorkerLeaseCount(), order).toBe(1);
      await host.experimental_dispose();
      vi.useRealTimers();
    }
  });

  it("no lease is no failure: a context without experimental_retainWorker, or whose call throws, still runs and answers (row 36)", async () => {
    const entry = await freshEntry();
    expect(await entry.handlers.run({ cwd: dir, args: ["repo", "--json"], timeoutMs: 5000, synsPath: syns.bin }, context())).toMatchObject({ exitCode: 0 });
    const throwing = await freshEntry();
    const answer = await throwing.handlers.run({ cwd: dir, args: ["repo", "--json"], timeoutMs: 5000, synsPath: syns.bin }, context({ experimental_retainWorker: () => { throw new Error("host call context is no longer active"); } }));
    expect(answer).toMatchObject({ exitCode: 0 });
  });

  it("the worker's lifecycle signal clears the timer (row 36)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const entry = await freshEntry();
    const lifecycle = new AbortController();
    let disposed = 0;
    await entry.handlers.run({ cwd: dir, args: ["repo", "--json"], timeoutMs: 5000, synsPath: syns.bin }, { signal: new AbortController().signal, lifecycle: { signal: lifecycle.signal }, experimental_retainWorker: () => ({ dispose: async () => void (disposed += 1) }) });
    expect(vi.getTimerCount()).toBe(1);
    lifecycle.abort();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(20 * MINUTE);
    expect(disposed).toBeLessThanOrEqual(1);
  });

  it("the Claude Code host takes no lease (row 36)", () => {
    for (const name of ["runner.ts", "process.ts", "main.ts"]) expect(readFileSync(new URL(`../hosts/claude/${name}`, import.meta.url), "utf8"), name).not.toMatch(/retainWorker/);
  });
});
