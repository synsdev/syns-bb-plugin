import { describe, expect, it } from "vitest";
import { buildArgs, createCli, type RunRequest, type RunResult } from "../src/cli.js";
import { fakeRunner, rec } from "./fake-runner.js";

const where = { hostId: "host_1", cwd: "/work" };
const limits = { processMs: 20, callMs: 60, perMachine: 2 };

describe("buildArgs (S2.11, S2.13)", () => {
  it("passes every option as --option=value, always adds --json, and puts positionals after --", () => {
    expect(buildArgs("ls", { recursive: true, version: "abc", missing: undefined, off: false }, ["notes"])).toEqual(["ls", "--recursive", "--version=abc", "--json", "--", "notes"]);
  });
  it("adds no -- when there is no positional", () => {
    expect(buildArgs("history", { limit: 20 })).toEqual(["history", "--limit=20", "--json"]);
  });
  it("repeats an option once for each value of a list", () => {
    expect(buildArgs("grep", { glob: ["*.md", "--json"], none: [] }, ["x"])).toEqual(["grep", "--glob=*.md", "--glob=--json", "--json", "--", "x"]);
  });
  it("keeps a value that looks like a flag inside its own argument (A32)", () => {
    expect(buildArgs("commit", { message: "--parent=evil" }, ["--json"])).toEqual(["commit", "--message=--parent=evil", "--json", "--", "--json"]);
  });
});

describe("createCli limits (S2.14, S2.15)", () => {
  it("gives one process at most the process limit", async () => {
    const runner = fakeRunner({ repo: rec("repo.ok") });
    await createCli(runner, limits).run(where, ["repo", "--json"], undefined, Date.now() + 1000);
    expect(runner.calls[0]).toMatchObject({ hostId: "host_1", cwd: "/work", args: ["repo", "--json"], timeoutMs: 20 });
  });
  it("gives a process no more time than the call has left", async () => {
    const runner = fakeRunner({ repo: rec("repo.ok") });
    await createCli(runner, limits).run(where, ["repo"], undefined, Date.now() + 10);
    expect(runner.calls[0]!.timeoutMs).toBeLessThanOrEqual(10);
  });
  it("runs at most perMachine processes at once on one machine, and the rest wait", async () => {
    let running = 0;
    let peak = 0;
    const runner = fakeRunner({
      repo: async () => {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise((resolve) => setTimeout(resolve, 5));
        running -= 1;
        return rec("repo.ok");
      },
    });
    const cli = createCli(runner, { ...limits, callMs: 1000 });
    const results = await Promise.all(Array.from({ length: 6 }, () => cli.run(where, ["repo"], undefined, Date.now() + 1000)));
    expect(peak).toBe(2);
    expect(results.every((result) => result.exitCode === 0)).toBe(true);
  });
  it("counts machines separately", async () => {
    let running = 0;
    let peak = 0;
    const runner = fakeRunner({
      repo: async () => {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise((resolve) => setTimeout(resolve, 5));
        running -= 1;
        return rec("repo.ok");
      },
    });
    const cli = createCli(runner, limits);
    await Promise.all(["a", "b"].flatMap((hostId) => [0, 1].map(() => cli.run({ hostId, cwd: "/w" }, ["repo"], undefined, Date.now() + 1000))));
    expect(peak).toBe(4);
  });
  it("answers timed out, without starting a process, when its turn comes after the deadline", async () => {
    const started: RunRequest[] = [];
    const runner = {
      async run(request: RunRequest): Promise<RunResult> {
        started.push(request);
        await new Promise((resolve) => setTimeout(resolve, 30));
        return rec("repo.ok");
      },
    };
    const cli = createCli(runner, { ...limits, perMachine: 1 });
    const [first, second] = await Promise.all([cli.run(where, ["repo"], undefined, Date.now() + 1000), cli.run(where, ["repo"], undefined, Date.now() + 10)]);
    expect(first.exitCode).toBe(0);
    expect(second.timedOut).toBe(true);
    expect(started).toHaveLength(1);
  });
});

describe("0.9: no pool, no perCall (rows 12, 27)", () => {
  it("cli.ts exports no pool and Limits has no perCall", async () => {
    const cli = await import("../src/cli.js");
    expect(cli).not.toHaveProperty("pool");
    expect(cli.LIMITS).toEqual({ processMs: 20_000, callMs: 25_000, perMachine: 16 });
  });
});
