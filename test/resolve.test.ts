import { describe, expect, it } from "vitest";
import { createResolve } from "../src/resolve.js";

const sdk = (thread: unknown, environment: unknown) => {
  const asked: unknown[] = [];
  return {
    asked,
    threads: { get: async (args: unknown) => (asked.push(args), thread) },
    environments: { get: async (args: unknown) => (asked.push(args), environment) },
  };
};

describe("resolve (S2.1, S2.2)", () => {
  it("reads the thread for its environment, and the environment for its host and folder", async () => {
    const fake = sdk({ id: "thr_1", environmentId: "env_1" }, { hostId: "host_1", path: "/work/checkout" });
    expect(await createResolve(fake)("thr_1")).toEqual({ hostId: "host_1", cwd: "/work/checkout" });
    expect(fake.asked).toEqual([{ threadId: "thr_1" }, { environmentId: "env_1" }]);
  });
  it("accepts the wrapped shapes too (HOST_FACTS §1)", async () => {
    const fake = sdk({ thread: { environmentId: "env_1" } }, { environment: { hostId: "host_1", path: "/w" } });
    expect(await createResolve(fake)("thr_1")).toEqual({ hostId: "host_1", cwd: "/w" });
  });
  it("answers null for a session without an environment, and asks no further", async () => {
    const fake = sdk({ id: "thr_1", environmentId: null }, {});
    expect(await createResolve(fake)("thr_1")).toBeNull();
    expect(fake.asked).toHaveLength(1);
  });
  it("answers null for an environment without a host or without a path", async () => {
    expect(await createResolve(sdk({ environmentId: "e" }, { path: "/w" }))("t")).toBeNull();
    expect(await createResolve(sdk({ environmentId: "e" }, { hostId: "h", path: "" }))("t")).toBeNull();
  });
});
