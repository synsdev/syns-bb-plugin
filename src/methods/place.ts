import { buildArgs } from "../cli.js";
import { fail } from "../errors.js";
import { K64, nullable, object, path, version, type ProcedureMethod } from "../method.js";

/** OWNER/NAME of a template repository. */
const template = { type: "string", minLength: 3, maxLength: 201, pattern: "^[a-z0-9][a-z0-9._-]*/[a-z0-9][a-z0-9._-]*$" };

/**
 * `syns place TEMPLATE PATH [--version N] --json` (D43). It acts on the
 * session's repository as a whole, so it runs at the session's folder even
 * from a document scoped to a placed folder. It publishes one version and writes the
 * files to the session's checkout. The CLI checks the head itself, so it takes
 * no base. It has no provenance flags, so the page's provenance goes in
 * SYNS_INTEGRATION, SYNS_RUN and SYNS_TRIGGER (D44).
 */
/** Working-copy states with no unpublished local edit, measured safe to place in (HOST_FACTS §16, D46): behind only, the place lands on the newer head and the next sync converges with no review. */
const CLEAN = new Set(["converged", "remote_changes"]);

export const place: ProcedureMethod = {
  name: "syns.place",
  description: "Place a template (OWNER/NAME, at version or its head) as a new folder at path of this session's repository: one version, the files on disk too. Runs at the session's folder whatever the scope.",
  effect: "contributed-write",
  unguarded: true,
  atRoot: true,
  minCli: "0.3.6",
  params: object({ template, path, version: { type: "integer", minimum: 1 } }, ["template", "path"]),
  result: {
    type: "object",
    properties: {
      path: { type: "string" },
      holder: { type: "string" },
      template: { type: "object", properties: { repo: { type: "string" }, version: { type: "integer" }, sha: { type: "string" } }, required: ["repo", "version", "sha"] },
      version,
      number: { type: "integer" },
      checks: { type: "array", items: { type: "string" } },
      enableChecks: nullable("string"),
    },
    required: ["path", "holder", "template", "version", "number", "checks", "enableChecks"],
  },
  maxRequestBytes: K64,
  maxResponseBytes: K64,
  reasons: ["occupied", "no_such_template", "stale_head", "checkout_dirty"],
  async procedure(params, context) {
    // The CLI's place does not refuse a checkout holding unpublished edits (HOST_FACTS §16), and it writes the
    // template's files into that checkout: with an agent mid-turn, its end-of-turn sync would stop for a review.
    const status = (await context.syns(["status", "--json"])) as Record<string, unknown>;
    if (!CLEAN.has(String(status.workingCopyState))) throw fail("checkout_dirty");
    // place takes no provenance flags; the CLI reads it from SYNS_* (D44).
    const out = (await context.syns(buildArgs("place", { version: params.version }, [params.template, params.path]), undefined, { provenanceEnv: true })) as Record<string, unknown>;
    const placed = (typeof out.template === "object" && out.template !== null ? out.template : {}) as Record<string, unknown>;
    return {
      path: out.path,
      holder: out.holder,
      template: { repo: placed.repo, version: placed.version, sha: placed.sha },
      version: out.commitSha,
      number: out.version,
      checks: Array.isArray(out.checks) ? out.checks : [],
      enableChecks: typeof out.enableChecks === "string" ? out.enableChecks : null,
    };
  },
};
