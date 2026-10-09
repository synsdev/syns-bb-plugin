import { describe, expect, it } from "vitest";
import { fakeBb } from "./fake-bb.js";
import { rec } from "./fake-runner.js";
import { HEAD } from "./harness.js";

describe("the server entry", () => {
  it("declares the two settings of spec 02", () => {
    const { described } = fakeBb({}, async () => rec("repo.ok"));
    expect(described).toMatchObject({ synsPath: { type: "string" }, agentInstructions: { type: "boolean", default: true } });
    expect(described.synsPath).not.toHaveProperty("default");
    expect(Object.keys(described).sort()).toEqual(["agentInstructions", "synsPath"]);
  });

  it("answers the host's two RPC methods and nothing else (S2.5)", () => {
    expect(Object.keys(fakeBb({}, async () => rec("repo.ok")).handlers).sort()).toEqual(["threadPagesContributions", "threadPagesInvoke"]);
  });

  it("declares the fragment unless agentInstructions is off (S4.5)", async () => {
    const on = (await fakeBb({}, async () => rec("repo.ok")).handlers.threadPagesContributions!(undefined)) as Record<string, unknown>;
    const off = (await fakeBb({ agentInstructions: false }, async () => rec("repo.ok")).handlers.threadPagesContributions!(undefined)) as Record<string, unknown>;
    expect(typeof on.instruction).toBe("string");
    expect(off).not.toHaveProperty("instruction");
    expect(off.methods).toEqual(on.methods);
  });

  it("runs the CLI through the host half of the session's machine, in its folder, with the synsPath setting", async () => {
    const asked: unknown[] = [];
    const { handlers } = fakeBb({ synsPath: "/opt/syns/bin/syns" }, async (method, input, options) => {
      asked.push({ method, input, options });
      return rec("repo.ok");
    });
    const answer = await handlers.threadPagesInvoke!({ method: "syns.repo", params: {}, caller: { sessionId: "thr_1" }, requestId: "r1" });
    expect(answer).toMatchObject({ ok: true, result: { owner: "acme", version: HEAD } });
    expect(asked).toEqual([{ method: "run", input: { cwd: "/work/checkout", args: ["repo", "--json"], timeoutMs: 20000, synsPath: "/opt/syns/bin/syns" }, options: { hostId: "host_9", timeoutMs: 25000 } }]);
  });

  it("sends no synsPath when the setting is unset or empty", async () => {
    const inputs: Record<string, unknown>[] = [];
    for (const synsPath of [undefined, "", "  "]) {
      const { handlers } = fakeBb(synsPath === undefined ? {} : { synsPath }, async (_method, input) => (inputs.push(input), rec("repo.ok")));
      await handlers.threadPagesInvoke!({ method: "syns.repo", params: {}, caller: { sessionId: "thr_1" }, requestId: "r1" });
    }
    for (const input of inputs) expect(input).not.toHaveProperty("synsPath");
  });

  it("a host call that fails is handler_error, logged, and never thrown at the host", async () => {
    const { handlers, lines } = fakeBb({}, async () => {
      throw new Error("host host_9 is offline");
    });
    const answer = await handlers.threadPagesInvoke!({ method: "syns.repo", params: {}, caller: { sessionId: "thr_1" }, requestId: "r1" });
    expect(answer).toMatchObject({ ok: false, error: { code: "handler_error" } });
    expect(lines.join("\n")).toContain("host_9 is offline");
  });
});
