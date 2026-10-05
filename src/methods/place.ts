import { buildArgs } from "../cli.js";
import { K64, nullable, object, path, version, type SimpleMethod } from "../method.js";

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
export const place: SimpleMethod = {
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
  reasons: ["occupied", "no_such_template", "stale_head"],
  // place takes no provenance flags; the CLI reads it from SYNS_* (D44).
  command: (params) => ({ args: buildArgs("place", { version: params.version }, [params.template, params.path]), provenanceEnv: true }),
  shape: (out) => {
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
