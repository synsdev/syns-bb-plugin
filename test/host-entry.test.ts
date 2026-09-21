import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { CLI_NOT_FOUND } from "../src/cli.js";
import hostEntry, { findSyns, runSyns } from "../src/host-entry.js";

// The SDK's host bundle loads only inside bb's host worker ("Dynamic require of child_process").
vi.mock("@get-bb/plugin-sdk/host", () => ({ experimental_defineHostEntry: (entry: unknown) => entry }));

const source = (name: string): string => readFileSync(new URL(`../src/${name}`, import.meta.url), "utf8");
const imports = (text: string): { names: string[]; from: string }[] =>
  [...text.matchAll(/import\s+(?:type\s+)?(?:\{([^}]*)\}|\*\s+as\s+\w+|\w+)\s+from\s+"([^"]+)"/g)].map((match) => ({ names: (match[1] ?? "*").split(",").map((name) => name.trim()).filter(Boolean), from: match[2]! }));

describe("the plugin opens no repository file (A5, S2.5, S2.6)", () => {
  it("the host half's only file-system access is looking for the executable", () => {
    const text = source("host-entry.ts");
    const fromFs = imports(text).filter((entry) => entry.from.startsWith("node:fs") || entry.from === "fs" || entry.from.startsWith("fs/"));
    expect(fromFs.flatMap((entry) => entry.names).sort()).toEqual(["access", "constants"]);
    expect(text).not.toMatch(/\brequire\s*\(|\bimport\s*\(/);
    expect(text).not.toMatch(/readFile|readdir|createReadStream|writeFile|\bopen(Sync)?\s*\(|opendir|\bstat(Sync)?\s*\(/);
  });
  it("starts the CLI with an argument array and no shell (S2.10)", () => {
    const text = source("host-entry.ts");
    const fromChild = imports(text).filter((entry) => entry.from === "node:child_process");
    expect(fromChild.flatMap((entry) => entry.names)).toEqual(["spawn"]);
    expect(text).not.toMatch(/shell\s*:/);
  });
  it("nothing else in the plugin touches the file system or starts a process", () => {
    const files = [...readdirSync(new URL("../src/", import.meta.url), { recursive: true })].map(String).filter((name) => name.endsWith(".ts") && name !== "host-entry.ts");
    expect(files.length).toBeGreaterThan(8);
    for (const name of files) {
      for (const entry of imports(source(name))) expect(entry.from, name).not.toMatch(/^(node:)?(fs|child_process)(\/|$)/);
    }
  });
});

describe("the host half, run against a stand-in executable", () => {
  const dir = mkdtempSync(join(tmpdir(), "syns-bb-plugin-host-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  /** An executable named `syns` in its own folder under the temporary one. */
  const script = (name: string, body: string): string => {
    const file = join(dir, name, "syns");
    mkdirSync(join(dir, name), { recursive: true });
    writeFileSync(file, `#!/bin/sh\n${body}\n`);
    chmodSync(file, 0o755);
    return file;
  };
  const signal = new AbortController().signal;

  it("finds syns on PATH first, then in the named folders under home, else not at all (S2.8)", async () => {
    const onPath = script("onpath", "exit 0");
    expect(await findSyns(undefined, { PATH: join(dir, "onpath") }, join(dir, "nohome"))).toBe(onPath);
    const inHome = script(join("home", ".cargo", "bin"), "exit 0");
    expect(await findSyns(undefined, { PATH: "" }, join(dir, "home"))).toBe(inHome);
  });

  it("a synsPath setting names the executable outright; one that is not there is not found (S2.8)", async () => {
    const named = script("named", "exit 0");
    expect(await findSyns(named, { PATH: "" }, join(dir, "nohome"))).toBe(named);
    expect(await findSyns(join(dir, "absent", "syns"), { PATH: join(dir, "onpath") }, join(dir, "nohome"))).toBeNull();
  });

  it("passes arguments as they are, standard input, and the folder; returns exit code and output", async () => {
    const bin = script("echo", 'printf "%s|" "$@"; printf "cwd=%s|" "$(pwd -P)"; cat; echo oops >&2; exit 3');
    const result = await runSyns(bin, ["a b", "$(id)", "; rm -rf x", "--", "-n"], dir, "from stdin", 5000, signal);
    expect(result.exitCode).toBe(3);
    expect(result.stdout).toContain("a b|$(id)|; rm -rf x|--|-n|");
    expect(result.stdout).toContain("from stdin");
    expect(result.stdout).toMatch(/cwd=.*syns-bb-plugin-host-/);
    expect(result.stderr).toBe("oops\n");
    expect(result).toMatchObject({ timedOut: false, spawnError: null, overflowed: false });
  });

  it("stops a process that outlives its limit (S2.14, A38)", async () => {
    const bin = script("slow", "sleep 10");
    const started = Date.now();
    const result = await runSyns(bin, [], dir, undefined, 150, signal);
    expect(result.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("stops a process that prints more than 4 MiB, and says so (S2.16)", async () => {
    const bin = script("loud", "head -c 6000000 /dev/zero | tr '\\0' 'x'; sleep 10");
    const started = Date.now();
    const result = await runSyns(bin, [], dir, undefined, 8000, signal);
    expect(result.overflowed).toBe(true);
    expect(result.stdout.length).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("reports a process that could not be started, in words that are not CLI_NOT_FOUND", async () => {
    const bin = script("fine", "exit 0");
    const result = await runSyns(bin, [], join(dir, "no-such-folder"), undefined, 1000, signal);
    expect(result.spawnError).toBeTruthy();
    expect(result.spawnError).not.toBe(CLI_NOT_FOUND);
  });

  it("with no executable to be found, answers CLI_NOT_FOUND and starts nothing (S3.6, A39)", async () => {
    const entry = hostEntry as unknown as { handlers: { run(input: Record<string, unknown>, context: { signal: AbortSignal }): Promise<Record<string, unknown>> } };
    const result = await entry.handlers.run({ cwd: dir, args: ["repo", "--json"], timeoutMs: 1000, synsPath: join(dir, "absent", "syns") }, { signal });
    expect(result).toEqual({ exitCode: null, stdout: "", stderr: "", timedOut: false, spawnError: CLI_NOT_FOUND, overflowed: false });
  });

  it("the handler runs the executable the setting names", async () => {
    const entry = hostEntry as unknown as { handlers: { run(input: Record<string, unknown>, context: { signal: AbortSignal }): Promise<Record<string, unknown>> } };
    const bin = script("handler", 'printf "%s " "$@"');
    const result = await entry.handlers.run({ cwd: dir, args: ["repo", "--json"], timeoutMs: 5000, synsPath: bin }, { signal });
    expect(result).toMatchObject({ exitCode: 0, stdout: "repo --json " });
  });
});
