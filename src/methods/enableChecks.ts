import { buildArgs } from "../cli.js";
import { K64, object, version, type SimpleMethod } from "../method.js";

/**
 * `syns enable-checks --json` in the page's placed folder (D49, D59): one
 * version of the holder turning on the checks the folder recorded from its
 * template. The CLI guards it against an unpublished edit itself, and reads
 * the page's provenance from SYNS_* (HOST_FACTS §17), as syns.place does
 * (D44). It takes no base: the CLI writes against the folder's own.
 */
export const enableChecks: SimpleMethod = {
  name: "syns.enableChecks",
  description: "Turn on, for everyone working in the holder, the checks this placed folder recorded from its template; they run on every push. enabled: [] makes no version. Only from the reader's own press, naming the commands.",
  effect: "contributed-write",
  unguarded: true,
  minCli: "0.3.6",
  params: object({}),
  result: {
    type: "object",
    properties: {
      holder: { type: "string" },
      path: { type: "string" },
      enabled: { type: "array", items: { type: "string" } },
      version,
      number: { type: "integer" },
    },
    required: ["holder", "path", "enabled"],
  },
  maxRequestBytes: K64,
  maxResponseBytes: K64,
  reasons: ["stale_head", "checkout_dirty"],
  command: () => ({ args: buildArgs("enable-checks"), provenanceEnv: true }),
  // D12's one renaming: the commit is `version`, its number `number`. Both only when a version was made.
  shape: (out) => ({
    holder: out.holder,
    path: out.path,
    enabled: Array.isArray(out.enabled) ? out.enabled.filter((one) => typeof one === "string") : out.enabled,
    ...(typeof out.commitSha === "string" ? { version: out.commitSha } : {}),
    ...(Number.isInteger(out.version) ? { number: out.version } : {}),
  }),
};
