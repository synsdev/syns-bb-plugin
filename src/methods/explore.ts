import { buildArgs } from "../cli.js";
import { K64, M1, nullable, object, NOT_FOUND, type Schema, type SimpleMethod } from "../method.js";

/** `syns explore`: public repositories, templates among them (D49). One command, its JSON passed on (D59). */

const row: Schema = {
  type: "object",
  properties: {
    owner: { type: "string" },
    name: { type: "string" },
    description: nullable("string"),
    tags: { type: "array", items: { type: "string" } },
    status: nullable("string"),
    visibility: { type: "string" },
    fileCount: { type: "integer" },
    forkCount: { type: "integer" },
    updatedAt: nullable("string"),
  },
  required: ["owner", "name"],
};
const exploreResult: Schema = { type: "object", properties: { total: { type: "integer" }, limit: { type: "integer" }, offset: { type: "integer" }, data: { type: "array", items: row } }, required: ["total", "data"] };

export const explore: SimpleMethod = {
  name: "syns.explore",
  description: "Public Syns repositories matching query, every tag in tags (syns-app for app templates) and status, limit at a time from offset; total says how many.",
  effect: "read",
  // Up to 0.3.5 the CLI sent query and tags under keys the server ignores: every public repository came back (issue 207).
  minCli: "0.3.6",
  params: object({
    query: { type: "string", maxLength: 200 },
    tags: { type: "array", items: { type: "string", maxLength: 100 }, maxItems: 8 },
    status: { type: "string", enum: ["active", "draft", "completed", "abandoned"], maxLength: 9 },
    limit: { type: "integer", minimum: 1, maximum: 100 },
    offset: { type: "integer", minimum: 0 },
  }),
  result: exploreResult,
  maxRequestBytes: K64,
  maxResponseBytes: M1,
  notFound: NOT_FOUND,
  command: (params) => ({ args: buildArgs("explore", { query: params.query, tag: params.tags, status: params.status, limit: params.limit, offset: params.offset }) }),
};
