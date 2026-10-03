import { describe, expect, it } from "vitest";
import { CLI_NOT_FOUND, createCli, type RunResult } from "../src/cli.js";
import { createDispatch } from "../src/dispatch.js";
import { METHODS } from "../src/methods/index.js";
import { fakeRunner, ok, rec, spawnFailed, timedOut } from "./fake-runner.js";
import { FAST, SAMPLES, failureOf, harness } from "./harness.js";

const everyVerb = (reply: RunResult) => Object.fromEntries(["repo", "whoami", "ls", "cat", "history", "commit", "read", "glob", "grep", "diff", "write", "edit", "rm", "revert", "place", "status", "share", "unshare", "collaborators", "enable-checks", "explore", "users"].map((verb) => [verb, reply]));

describe("the samples", () => {
  it("cover exactly the registered methods", () => expect(Object.keys(SAMPLES).sort()).toEqual(METHODS.map((method) => method.name).sort()));
});

describe("dispatch", () => {
  it("answers unknown_method for a name the table does not hold, and runs nothing", async () => {
    const h = harness();
    expect(failureOf(await h.call("syns.nope")).code).toBe("unknown_method");
    expect(failureOf(await h.call("syns.push", { path: "a" })).code).toBe("unknown_method");
    expect(h.runner.calls).toHaveLength(0);
  });

  it("from the home page every method answers no_repo, and no machine is called (A35, S2.2)", async () => {
    const h = harness();
    for (const method of METHODS) {
      expect(failureOf(await h.call(method.name, SAMPLES[method.name], null)), method.name).toMatchObject({ code: "unavailable", reason: "no_repo" });
    }
    expect(h.resolved).toHaveLength(0);
    expect(h.runner.calls).toHaveLength(0);
  });

  it("a session with no environment, host or folder answers no_repo without calling a machine (S2.2)", async () => {
    const h = harness({}, { where: null });
    for (const method of METHODS) expect(failureOf(await h.call(method.name, SAMPLES[method.name])).reason, method.name).toBe("no_repo");
    expect(h.runner.calls).toHaveLength(0);
  });

  it("takes the session from caller.sessionId and runs the CLI in that session's folder on its machine (S2.1)", async () => {
    const h = harness({ repo: rec("repo.ok") });
    await h.call("syns.repo", {}, "thr_other");
    expect(h.resolved).toEqual(["thr_other"]);
    expect(h.runner.calls[0]).toMatchObject({ hostId: "host_1", cwd: "/work/checkout" });
  });

  it("outside any checkout every method that needs a repository answers no_repo, from the CLI's own answer (A4, S2.4)", async () => {
    const h = harness({ ...everyVerb(rec("no-identity")), whoami: rec("whoami.ok"), explore: rec("explore.ok"), users: rec("users.ok") });
    for (const method of METHODS) {
      const answer = await h.call(method.name, SAMPLES[method.name]);
      // S1.12: whoami works in a folder that holds no repository; so do explore and users, which read no repository (D50).
      if (["syns.whoami", "syns.explore", "syns.users"].includes(method.name)) expect(answer.ok, method.name).toBe(true);
      else expect(failureOf(answer), method.name).toMatchObject({ code: "unavailable", reason: "no_repo" });
    }
  });

  it("with no executable every method answers cli_missing (A39)", async () => {
    const h = harness(everyVerb(spawnFailed(CLI_NOT_FOUND)));
    for (const method of METHODS) expect(failureOf(await h.call(method.name, SAMPLES[method.name])), method.name).toMatchObject({ code: "unavailable", reason: "cli_missing" });
  });

  it("a process the host half stopped answers timeout (A38)", async () => {
    const h = harness(everyVerb(timedOut()));
    for (const method of METHODS) expect(failureOf(await h.call(method.name, SAMPLES[method.name])), method.name).toMatchObject({ code: "unavailable", reason: "timeout" });
  });

  it("asks the host half to stop a process at the process limit, and answers timeout within the call limit whatever happens (A38, S2.14)", async () => {
    const h = harness({ repo: () => new Promise(() => undefined) });
    const started = Date.now();
    const answer = await h.call("syns.repo");
    expect(failureOf(answer)).toMatchObject({ code: "unavailable", reason: "timeout" });
    expect(Date.now() - started).toBeLessThan(FAST.callMs + 40);
    expect(h.runner.calls[0]!.timeoutMs).toBe(FAST.processMs);
  });

  it("output that is not JSON is handler_error; the log names method, session and exit code, never the text (A40, S2.18, S2.20)", async () => {
    const g = harness({ ls: rec("not-json") });
    const error = failureOf(await g.call("syns.ls", {}, "thr_page"));
    expect(error.code).toBe("handler_error");
    expect(error).not.toHaveProperty("reason");
    expect(g.log).toHaveLength(1);
    expect(g.log[0]).toContain("syns.ls");
    expect(g.log[0]).toContain("thr_page");
    expect(g.log[0]).toContain("exit=0");
    expect(g.log[0]).not.toContain("secret file text");
    expect(error.message).not.toContain("secret file text");
  });

  it("an unrecognised CLI failure is handler_error, logged with the first 500 characters of its output (S2.18)", async () => {
    const h = harness({ commit: rec("malformed-changeset") });
    expect(failureOf(await h.call("syns.commit", SAMPLES["syns.commit"])).code).toBe("handler_error");
    expect(h.log.some((line) => line.includes("syns.commit") && line.includes("thr_page") && line.includes("exit=1") && line.includes("does not parse"))).toBe(true);
  });

  it("a success whose output lacks a required field is handler_error, never a result with a hole (S3.7)", async () => {
    const h = harness({ repo: ok({ name: "x", commitSha: null, role: "owner", visibility: "private", fileCount: 0 }) });
    expect(failureOf(await h.call("syns.repo")).code).toBe("handler_error");
    expect(h.log[0]).toContain("syns.repo");
  });

  it("a failure to resolve the session is handler_error, logged", async () => {
    const invoke = createDispatch({
      cli: createCli(fakeRunner(), FAST),
      resolve: async () => {
        throw new Error("sdk down");
      },
      log: { info: () => undefined, warn: () => undefined },
    });
    const answer = await invoke({ method: "syns.repo", params: {}, caller: { sessionId: "thr_1" }, requestId: "r" });
    expect(failureOf(answer).code).toBe("handler_error");
  });

  it("treats absent params as an empty object, as the host does", async () => {
    const h = harness({ repo: rec("repo.ok") });
    expect((await h.call("syns.repo", undefined)).ok).toBe(true);
    expect((await h.call("syns.repo", null)).ok).toBe(true);
  });
});

describe("safety", () => {
  it("a sessionId, repo or cwd key in any method's parameters is rejected, and no process runs (A34, S1.2)", async () => {
    const h = harness();
    for (const method of METHODS) {
      for (const key of ["sessionId", "repo", "cwd", "command", "flag"]) {
        expect(failureOf(await h.call(method.name, { ...SAMPLES[method.name], [key]: "x" })).code, `${method.name} ${key}`).toBe("invalid_params");
      }
    }
    expect(h.runner.calls).toHaveLength(0);
  });

  const BAD_PATHS = ["-rf", "--version=1", "a/../b", "..", "/etc/passwd", "a\u0000b", "a\tb", "a\\b", ""];
  it("a bad path is invalid_params wherever a method takes one, and no process runs (A31, S2.9)", async () => {
    const h = harness();
    for (const bad of BAD_PATHS) {
      const calls: [string, Record<string, unknown>][] = [
        ["syns.ls", { path: bad }],
        ["syns.history", { path: bad }],
        ["syns.readMany", { paths: ["ok.md", bad] }],
        ["syns.commit", { ...SAMPLES["syns.commit"], files: [{ path: bad, text: "x" }] }],
        ["syns.commit", { ...SAMPLES["syns.commit"], deletions: [bad] }],
        ["syns.read", { path: bad }],
        ["syns.glob", { pattern: "*", path: bad }],
        ["syns.grep", { pattern: "x", path: bad }],
        ["syns.write", { ...SAMPLES["syns.write"], path: bad }],
        ["syns.write", { ...SAMPLES["syns.write"], path: bad, create: true }],
        ["syns.edit", { ...SAMPLES["syns.edit"], path: bad }],
        ["syns.rm", { ...SAMPLES["syns.rm"], path: bad }],
        ["syns.revert", { ...SAMPLES["syns.revert"], path: bad }],
      ];
      for (const [method, params] of calls) expect(failureOf(await h.call(method, params)).code, `${method} ${JSON.stringify(bad)}`).toBe("invalid_params");
    }
    expect(h.runner.calls).toHaveLength(0);
  });
});
