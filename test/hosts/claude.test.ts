import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildDeclaration } from "../../src/declaration.js";
import { METHODS } from "../../src/methods/index.js";
import { serve, type Served } from "../../hosts/claude/process.js";
import { fakeBb } from "../fake-bb.js";
import { rec } from "../fake-runner.js";

const SESSION = "aaaaaaaa-1111-2222-3333-444444444444";
const REPO = { owner: "acme", name: "crm", commitSha: "7ca9bc78ba047d9e7798b8d2733c254e24cfc837", status: "draft", visibility: "private", fileCount: 3, role: "owner" };

/** A Unife Pages daemon's control socket, as much of it as the process uses. */
function fakeDaemon(socketPath: string) {
  const seen = { registrations: [] as Record<string, unknown>[], deletes: [] as string[] };
  let pid = 4242;
  const server = http.createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (d: string) => (body += d));
    req.on("end", () => {
      const json = (status: number, value: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
      if (req.method === "GET" && req.url === "/v1/daemon") return json(200, { version: "test", pid, port: 0, origin: "", sessions: 1, protocol: 1 });
      if (req.method === "POST" && req.url === "/v1/contributors") return (seen.registrations.push(JSON.parse(body)), json(201, { ok: true }));
      if (req.method === "DELETE" && req.url?.startsWith("/v1/contributors/")) return (seen.deletes.push(req.url), json(200, { ok: true }));
      json(404, { error: "not_found" });
    });
  });
  return {
    seen,
    restart: () => void (pid += 1),
    listen: () => new Promise<void>((resolve) => server.listen(socketPath, () => resolve())),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** What the daemon does with a call: POST { namespace, ...call } to the registered endpoint (claude-pages provider.ts). */
function post(endpoint: string, call: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
  const [, socketPath, path] = /^unix:(.+?):(\/.*)$/.exec(endpoint)!;
  return new Promise((resolve, reject) => {
    const text = JSON.stringify({ namespace: "syns", ...call });
    const req = http.request({ socketPath, path, method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(text) } }, (res) => {
      let out = "";
      res.setEncoding("utf8");
      res.on("data", (d: string) => (out += d));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: out ? JSON.parse(out) : null }));
    });
    req.on("error", reject);
    req.end(text);
  });
}

describe("Claude Code: the declaration is bb's, byte for byte (07 R-X1)", () => {
  for (const agentInstructions of [true, false]) {
    it(`with agentInstructions ${agentInstructions}: what the process registers equals what threadPagesContributions answers`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "syns-rx1-"));
      const daemon = fakeDaemon(join(dir, "control.sock"));
      await daemon.listen();
      const served = await serve({ socket: join(dir, "control.sock"), agentInstructions, log: { info: () => undefined, warn: () => undefined }, everyMs: 50 });
      try {
        await vi.waitFor(() => expect(daemon.seen.registrations).toHaveLength(1));
        const bb = await fakeBb({ agentInstructions }, async () => rec("repo.ok")).handlers.threadPagesContributions!(undefined);
        expect(JSON.stringify(daemon.seen.registrations[0]!.declaration)).toBe(JSON.stringify(bb));
        expect(JSON.stringify(bb)).toBe(JSON.stringify(buildDeclaration(METHODS, { agentInstructions })));
      } finally {
        await served.stop();
        await daemon.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});

describe("Claude Code: the process against a daemon's control socket (R-X5)", () => {
  let dir = "";
  let served: Served | null = null;
  let daemon: ReturnType<typeof fakeDaemon> | null = null;
  afterEach(async () => {
    await served?.stop();
    await daemon?.close();
    served = null;
    daemon = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  /** A checkout with one placed folder, a plain folder, and a stand-in `syns` that logs where it ran. */
  function machine() {
    dir = mkdtempSync(join(tmpdir(), "syns-claude-"));
    const checkout = join(dir, "checkout");
    mkdirSync(join(checkout, "clients", "vela", "crm"), { recursive: true });
    mkdirSync(join(checkout, "notes"), { recursive: true });
    writeFileSync(join(checkout, ".syns.yaml"), "repo: acme/crm\n");
    writeFileSync(join(checkout, "clients", "vela", "crm", ".syns.yaml"), "holder: acme/crm\npath: clients/vela/crm\n");
    const log = join(dir, "runs.log");
    const synsPath = join(dir, "syns");
    writeFileSync(join(dir, "repo.json"), JSON.stringify(REPO));
    writeFileSync(synsPath, `#!/bin/sh\necho "$(pwd -P) $*" >> "${log}"\ncase "$1" in\n  --version) echo "syns 0.3.14" ;;\n  repo) cat "${join(dir, "repo.json")}" ;;\n  *) echo '{"error":"unexpected"}' >&2; exit 2 ;;\nesac\n`);
    chmodSync(synsPath, 0o755);
    const runs = (): string[] => readFileSync(log, "utf8").trim().split("\n");
    return { checkout, synsPath, runs };
  }

  it("registers with a Unix-socket endpoint, answers the daemon's POST in the session's folder, re-registers after a restart, unregisters on stop", async () => {
    const { checkout, synsPath, runs } = machine();
    daemon = fakeDaemon(join(dir, "control.sock"));
    await daemon.listen();
    const lines: string[] = [];
    served = await serve({ socket: join(dir, "control.sock"), synsPath, agentInstructions: true, log: { info: (l) => lines.push(l), warn: (l) => lines.push(l) }, everyMs: 50 });
    await vi.waitFor(() => expect(daemon!.seen.registrations).toHaveLength(1));
    const reg = daemon.seen.registrations[0]!;
    expect(reg).toMatchObject({ kind: "process", namespace: "syns", endpoint: served.endpoint });
    expect(served.endpoint).toMatch(/^unix:\/.+\/invoke\.sock:\/invoke$/);
    expect(lines[0]).toMatch(/^registered syns \S+ with the Unife Pages daemon 4242$/);

    const answer = await post(served.endpoint, { method: "syns.repo", params: {}, caller: { sessionId: SESSION, scope: null, workspace: { id: "ws", path: checkout, machine: null } }, requestId: "r1" });
    expect(answer).toMatchObject({ status: 200, body: { ok: true, result: { owner: "acme", name: "crm", version: REPO.commitSha } } });
    expect(runs()).toEqual([`${realpathSync(checkout)} repo --json`]);

    daemon.restart();
    await vi.waitFor(() => expect(daemon!.seen.registrations).toHaveLength(2));
    await served.stop();
    served = null;
    expect(daemon.seen.deletes).toEqual(["/v1/contributors/syns"]);
  });

  it("a scope runs the CLI in the placed folder, checked on this machine; a plain folder is bad_scope; a session with no folder is no_repo", async () => {
    const { checkout, synsPath, runs } = machine();
    daemon = fakeDaemon(join(dir, "control.sock"));
    await daemon.listen();
    served = await serve({ socket: join(dir, "control.sock"), synsPath, agentInstructions: true, log: { info: () => undefined, warn: () => undefined }, everyMs: 50 });
    await vi.waitFor(() => expect(daemon!.seen.registrations).toHaveLength(1));

    const scoped = await post(served.endpoint, { method: "syns.repo", params: {}, caller: { sessionId: SESSION, scope: "clients/vela/crm", workspace: { id: "ws", path: checkout, machine: null } }, requestId: "r2" });
    expect(scoped).toMatchObject({ status: 200, body: { ok: true } });
    // the same-repository check at the session's folder and at the scope (D46), then the call itself in the scope
    expect(runs()).toEqual([`${realpathSync(checkout)} repo --json`, ...Array(2).fill(`${realpathSync(join(checkout, "clients/vela/crm"))} repo --json`)]);

    expect(await post(served.endpoint, { method: "syns.repo", params: {}, caller: { sessionId: SESSION, scope: "notes", workspace: { id: "ws", path: checkout, machine: null } }, requestId: "r3" })).toMatchObject({ body: { ok: false, error: { reason: "bad_scope" } } });
    expect(await post(served.endpoint, { method: "syns.repo", params: {}, caller: { sessionId: SESSION, scope: "../elsewhere", workspace: { id: "ws", path: checkout, machine: null } }, requestId: "r4" })).toMatchObject({ body: { ok: false, error: { reason: "bad_scope" } } });
    expect(await post(served.endpoint, { method: "syns.repo", params: {}, caller: { sessionId: "bbbbbbbb-0000-0000-0000-000000000000", scope: null, workspace: null }, requestId: "r5" })).toMatchObject({ body: { ok: false, error: { reason: "no_repo" } } });
    expect(await post(served.endpoint, { method: "syns.repo", params: {}, caller: { sessionId: null, scope: null, workspace: null }, requestId: "r6" })).toMatchObject({ body: { ok: false, error: { reason: "no_repo" } } });
  });

  it("no syns executable is cli_missing; anything but POST /invoke is 404", async () => {
    const { checkout } = machine();
    daemon = fakeDaemon(join(dir, "control.sock"));
    await daemon.listen();
    served = await serve({ socket: join(dir, "control.sock"), synsPath: join(dir, "missing"), agentInstructions: true, log: { info: () => undefined, warn: () => undefined }, everyMs: 50 });
    expect(await post(served.endpoint, { method: "syns.repo", params: {}, caller: { sessionId: SESSION, scope: null, workspace: { id: "ws", path: checkout, machine: null } }, requestId: "r1" })).toMatchObject({ body: { ok: false, error: { reason: "cli_missing" } } });
    const [, socketPath] = /^unix:(.+?):/.exec(served.endpoint)!;
    const status = await new Promise<number>((resolve) => http.get({ socketPath, path: "/invoke" }, (res) => (res.resume(), resolve(res.statusCode ?? 0))));
    expect(status).toBe(404);
  });
});

describe("Claude Code: the plugin folder the daemon starts (U45)", () => {
  const folder = new URL("../../hosts/claude/", import.meta.url);

  it("declares syns and a process that exists, and the committed bundle is what the sources build", () => {
    expect(JSON.parse(readFileSync(new URL("unife-pages.json", folder), "utf8"))).toEqual({ contributor: { namespace: "syns", process: "bin/syns-pages.mjs" } });
    const scratch = mkdtempSync(join(tmpdir(), "syns-bundle-"));
    const out = join(scratch, "fresh.mjs");
    execFileSync(new URL("../../node_modules/.bin/rolldown", import.meta.url).pathname, ["hosts/claude/main.ts", "--platform", "node", "--format", "esm", "--file", out], { cwd: new URL("../..", import.meta.url).pathname, stdio: "ignore" });
    const fresh = readFileSync(out, "utf8");
    rmSync(scratch, { recursive: true, force: true });
    expect(fresh, "run npm run build:claude").toBe(readFileSync(new URL("bin/syns-pages.mjs", folder), "utf8"));
    // The plugin's version is the package's.
    expect(JSON.parse(readFileSync(new URL(".claude-plugin/plugin.json", folder), "utf8")).version).toBe(JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version);
  });

  it("the bundle, started as the daemon starts it, registers with its token, answers a call, and leaves when that daemon is gone", async () => {
    const dir = mkdtempSync(join(tmpdir(), "syns-started-"));
    const sock = join(dir, "given.sock");
    const tokens: (string | undefined)[] = [];
    const registrations: Record<string, unknown>[] = [];
    let pid = 7;
    const server = http.createServer((req, res) => {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (d: string) => (body += d));
      req.on("end", () => {
        const json = (status: number, v: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(v));
        if (req.url === "/v1/daemon") return json(200, { pid });
        if (req.method === "POST" && req.url === "/v1/contributors") { registrations.push(JSON.parse(body)); tokens.push(req.headers["x-unife-contributor-token"] as string | undefined); return json(201, { ok: true }); }
        json(404, {});
      });
    });
    await new Promise<void>((r) => server.listen(sock, () => r()));
    const child = spawn(process.execPath, [new URL("bin/syns-pages.mjs", folder).pathname], { cwd: new URL(".", folder).pathname, env: { ...process.env, UNIFE_PAGES_CONTROL_SOCKET: sock, UNIFE_PAGES_CONTRIBUTOR_TOKEN: "tok_9", SYNS_PATH: join(dir, "missing") }, stdio: ["ignore", "ignore", "ignore"] });
    try {
      await vi.waitFor(() => expect(registrations).toHaveLength(1), { timeout: 10_000 });
      expect(tokens).toEqual(["tok_9"]);
      expect(JSON.stringify(registrations[0]!.declaration)).toBe(JSON.stringify(buildDeclaration(METHODS, { agentInstructions: true })));
      const answer = await post(registrations[0]!.endpoint as string, { method: "syns.repo", params: {}, caller: { sessionId: SESSION, scope: null, workspace: { id: "w", path: dir, machine: null } }, requestId: "r1" });
      expect(answer).toMatchObject({ status: 200, body: { ok: false, error: { reason: "cli_missing" } } });
      pid = 8;
      await vi.waitFor(() => expect(child.exitCode).toBe(0), { timeout: 10_000 });
    } finally {
      child.kill("SIGKILL");
      await new Promise<void>((r) => server.close(() => r()));
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});
