import { optionsFromEnv, serve } from "./process.js";

/**
 * Run by hand, or by a plugin that starts it: `node dist/claude/process.js`. Ctrl-C or SIGTERM unregisters.
 * Settings are the environment: SYNS_PATH (the executable), SYNS_PAGES_INSTRUCTION=0 (declare no fragment),
 * UNIFE_PAGES_HOME (the daemon's home).
 */
const say = (line: string): void => void process.stderr.write(`syns: ${line}\n`);
const served = await serve(optionsFromEnv(process.env, { info: say, warn: say }));
say(`answering at ${served.endpoint}`);
const stop = (): void => void served.stop().finally(() => process.exit(0));
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
