import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createCli } from "../../src/cli.js";
import { buildDeclaration } from "../../src/declaration.js";
import { createDispatch, type Call, type Log } from "../../src/dispatch.js";
import { METHODS } from "../../src/methods/index.js";
import { createLocalRunner } from "./runner.js";

/**
 * The Syns contributor on Claude Code: a process contributor (unife-pages 07 R-X5, U24). It registers the same
 * declaration bb gets (R-X1) with the Unife Pages daemon over its control socket, and answers each call the daemon
 * POSTs to it with the same dispatch as bb's plugin, the CLI running on this machine in the folder the call names
 * (`caller.workspace`, U44).
 *
 *   POST   /v1/contributors            { kind: "process", namespace: "syns", declaration, endpoint } → 201
 *   DELETE /v1/contributors/syns       on stop
 *   the daemon POSTs { namespace, method, params, caller, requestId } to the endpoint and reads the answer
 *
 * The endpoint is a Unix socket in a folder only this user can open, so no browser and no other user reaches it.
 * Started by the daemon from this plugin's unife-pages.json (U45), it registers with the token it was given and lives
 * as long as that daemon. Started by hand, it registers again after a daemon restart, and a refusal (another
 * registrant holds `syns`, or an installed plugin declares it) is logged and tried again a minute later.
 */
export const NAMESPACE = "syns";
const CONTROL_SOCKET = "control.sock";
const BODY_LIMIT = 8 * 1024 * 1024;

export interface ServeOptions {
  /** The daemon's control socket: the one a daemon that started this process names (`UNIFE_PAGES_CONTROL_SOCKET`), else the one in its home (`$UNIFE_PAGES_HOME`, else `~/.unife-pages`). */
  socket: string;
  /** The token a daemon that started this process gave it (`UNIFE_PAGES_CONTRIBUTOR_TOKEN`, U45): it alone may hold a namespace a plugin declares. */
  token?: string | undefined;
  /** Called when the daemon that started this process is gone and another answers: that one starts its own. */
  onDaemonGone?: () => void;
  /** The `syns` executable, when it is not on PATH or in the usual folders (bb's `synsPath` setting). */
  synsPath?: string | undefined;
  /** Whether the declaration carries the instruction fragment (bb's `agentInstructions` setting). */
  agentInstructions: boolean;
  log: Log;
  /** How often the daemon's pid is checked. */
  everyMs?: number;
}

export interface Served {
  endpoint: string;
  /** Unregisters (unless told not to), closes the endpoint and removes its folder. */
  stop(unregister?: boolean): Promise<void>;
}

/** What the environment says, as `serve` takes it. */
export function optionsFromEnv(env: NodeJS.ProcessEnv, log: Log): ServeOptions {
  return {
    socket: env.UNIFE_PAGES_CONTROL_SOCKET || join(env.UNIFE_PAGES_HOME || join(homedir(), ".unife-pages"), CONTROL_SOCKET),
    token: env.UNIFE_PAGES_CONTRIBUTOR_TOKEN || undefined,
    synsPath: env.SYNS_PATH?.trim() || undefined,
    agentInstructions: env.SYNS_PAGES_INSTRUCTION !== "0",
    log,
  };
}

/** One request on the daemon's control socket. */
export type Control = (method: string, path: string, body?: unknown) => Promise<{ status: number; text: string }>;

/** HTTP over the daemon's control socket. */
export function controlOver(socketPath: string, token?: string): Control {
  return (method, path, body) =>
    new Promise((resolve, reject) => {
      const text = body === undefined ? undefined : JSON.stringify(body);
      const headers = { ...(text === undefined ? {} : { "content-type": "application/json", "content-length": Buffer.byteLength(text) }), ...(token ? { "x-unife-contributor-token": token } : {}) };
      const req = http.request({ socketPath, path, method, timeout: 5_000, headers }, (res) => {
        let out = "";
        res.setEncoding("utf8");
        res.on("data", (d: string) => (out += d));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text: out }));
      });
      req.on("timeout", () => req.destroy(new Error("timeout")));
      req.on("error", reject);
      req.end(text);
    });
}

export async function serve(options: ServeOptions): Promise<Served> {
  const { log } = options;
  const control = controlOver(options.socket, options.token);
  const invoke = createDispatch({ cli: createCli(createLocalRunner(options.synsPath)), log });
  const declaration = buildDeclaration(METHODS, { agentInstructions: options.agentInstructions });

  const server = http.createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/invoke") {
      res.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > BODY_LIMIT) req.destroy();
      else chunks.push(chunk);
    });
    req.on("end", () => {
      let call: Call;
      try {
        // The daemon adds the namespace; the call is the rest (07 §The call).
        const { namespace: _namespace, ...rest } = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Call & { namespace?: string };
        call = rest;
      } catch {
        res.writeHead(400).end();
        return;
      }
      void invoke(call).then((answer) => {
        const text = JSON.stringify(answer);
        res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(text) }).end(text);
      });
    });
  });

  const folder = mkdtempSync(join(tmpdir(), "syns-pages-"));
  const socketPath = join(folder, "invoke.sock");
  await new Promise<void>((resolve, reject) => server.once("error", reject).listen(socketPath, () => resolve()));
  const endpoint = `unix:${socketPath}:/invoke`;

  let registeredWith: number | null = null;
  let firstDaemon: number | null = null;
  let retryAt = 0;
  const tick = async (): Promise<void> => {
    let pid: number;
    try {
      pid = (JSON.parse((await control("GET", "/v1/daemon")).text) as { pid: number }).pid;
    } catch {
      registeredWith = null; // no daemon yet, or gone
      return;
    }
    if (options.token) {
      firstDaemon ??= pid;
      if (pid !== firstDaemon) {
        log.info(`the daemon that started this process is gone; daemon ${pid} starts its own`);
        options.onDaemonGone?.();
        return;
      }
    }
    if (pid === registeredWith || Date.now() < retryAt) return;
    const answer = await control("POST", "/v1/contributors", { kind: "process", namespace: NAMESPACE, declaration, endpoint }).catch((error: Error) => ({ status: 0, text: error.message }));
    if (answer.status === 201) {
      registeredWith = pid;
      retryAt = 0;
      log.info(`registered ${NAMESPACE} ${declaration.version} with the Unife Pages daemon ${pid}`);
    } else {
      retryAt = Date.now() + 60_000;
      log.warn(`registration refused: ${answer.status} ${answer.text.slice(0, 200)}${answer.status === 403 ? " (an installed plugin may declare this namespace; see the daemon's log)" : ""}`);
    }
  };
  let ticking: Promise<void> = tick();
  const timer = setInterval(() => void (ticking = ticking.then(tick)), options.everyMs ?? 5_000);

  return {
    endpoint,
    async stop(unregister = true) {
      clearInterval(timer);
      await ticking.catch(() => undefined);
      if (unregister && registeredWith !== null) await control("DELETE", `/v1/contributors/${NAMESPACE}`).catch(() => undefined);
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(folder, { recursive: true, force: true });
    },
  };
}
