import { describe, expect, it } from "vitest";
import { createHostRunner, type HostCall } from "../src/host-runner.js";
import { SLICE, createRelay } from "../src/relay.js";

/** D32: one bb host call carries at most 8 MiB of JSON either way (HOST_FACTS §12). */
const HOST_CALL_MAX = 8 * 1024 * 1024;

/** A host half as bb runs it: the relay, a process that echoes what it was given, and bb's bound on each call. */
function fakeHost(echo: (stdin: Buffer | string | undefined) => string, now = () => 0) {
  const relay = createRelay(now);
  const calls: string[] = [];
  const call: HostCall = async (method, input) => {
    if (Buffer.byteLength(JSON.stringify(input)) > HOST_CALL_MAX) throw new Error(`host input for ${method} exceeds ${HOST_CALL_MAX} bytes`);
    calls.push(method);
    let output: unknown;
    if (method === "stdinPart") output = { received: relay.append(input.id as string, input.base64 as string) };
    else if (method === "outputPart") {
      const slice = relay.slice(input.id as string, input.offset as number);
      output = slice ? { ...slice, lost: false } : { chunk: "", done: true, lost: true };
    } else {
      let stdin: Buffer | string | undefined = input.stdin as string | undefined;
      if (input.stdinBase64 !== undefined) stdin = Buffer.from(input.stdinBase64 as string, "base64");
      if (input.stdinFrom !== undefined) stdin = Buffer.from(relay.take(input.stdinFrom as string)!, "base64");
      const stdout = echo(stdin);
      const result = { exitCode: 0, stdout, stderr: "", timedOut: false, spawnError: null, overflowed: false };
      if (stdout.length <= SLICE) output = result;
      else {
        relay.hold("out-1", stdout);
        output = { ...result, stdout: stdout.slice(0, SLICE), rest: { id: "out-1", length: stdout.length } };
      }
    }
    if (Buffer.byteLength(JSON.stringify(output)) > HOST_CALL_MAX) throw new Error(`host output for ${method} exceeds ${HOST_CALL_MAX} bytes`);
    return output;
  };
  return { call, calls };
}

const request = { hostId: "host_1", cwd: "/w", args: ["x"], timeoutMs: 1000 };
const bytesOf = (size: number): Buffer => Buffer.from(Array.from({ length: size }, (_, index) => (index * 31) & 0xff));

describe("the relay between the halves (D32)", () => {
  it("a small run is one host call, as before", async () => {
    const host = fakeHost(() => '{"ok":true}');
    const result = await createHostRunner(host.call, async () => undefined).run({ ...request, stdin: "text" });
    expect(result.stdout).toBe('{"ok":true}');
    expect(host.calls).toEqual(["run"]);
  });

  it("an answer past one host call comes back whole, in slices", async () => {
    const picture = bytesOf(25 * 1024 * 1024);
    const answer = JSON.stringify({ contentBase64: picture.toString("base64") });
    const host = fakeHost(() => answer);
    const result = await createHostRunner(host.call, async () => undefined).run(request);
    expect(result.stdout).toBe(answer);
    expect(host.calls.filter((method) => method === "outputPart").length).toBe(Math.ceil(answer.length / SLICE) - 1);
  });

  it("a standard input past one host call reaches the process whole, gathered first", async () => {
    const picture = bytesOf(20 * 1024 * 1024);
    let seen: Buffer | undefined;
    const host = fakeHost((stdin) => {
      seen = stdin as Buffer;
      return "{}";
    });
    await createHostRunner(host.call, async () => undefined).run({ ...request, stdinBase64: picture.toString("base64") });
    expect(seen?.equals(picture)).toBe(true);
    expect(host.calls.at(-1)).toBe("run");
    expect(host.calls.filter((method) => method === "stdinPart").length).toBeGreaterThan(1);
  });

  it("slices of standard input are whole base64 groups", () => {
    expect(SLICE % 4).toBe(0);
  });

  it("the relay lets go of what nobody touched for a minute", () => {
    let at = 0;
    const relay = createRelay(() => at);
    relay.hold("a", "x".repeat(10));
    at = 61_000;
    expect(relay.slice("a", 0)).toBeUndefined();
    relay.append("b", "AAAA");
    at = 121_001;
    expect(relay.take("b")).toBeUndefined();
  });

  it("the relay holds at most its total, dropping the oldest", () => {
    const relay = createRelay(() => 0, 10);
    relay.hold("a", "12345678");
    relay.hold("b", "1234");
    expect(relay.slice("a", 0)).toBeUndefined();
    expect(relay.slice("b", 0)).toEqual({ chunk: "1234", done: true });
  });

  it("a host call that fails is handler_error material, not a crash", async () => {
    const runner = createHostRunner(async () => {
      throw new Error("host output for run exceeds 8388608 bytes");
    }, async () => undefined);
    expect((await runner.run(request)).spawnError).toMatch(/host call failed: host output/);
  });
});
