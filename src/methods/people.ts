import { buildArgs } from "../cli.js";
import { K64, M1, group, nullable, object, NOT_FOUND, type Schema, type SimpleMethod } from "../method.js";

/**
 * The scope's people (D49, D59): `syns collaborators` and its verbs, one
 * command each, in the page's scope folder. The CLI decides whose
 * collaborators they are and which roles it takes; inside a placed folder it
 * answers holder root required, which comes back as bad_scope (HOST_FACTS §17).
 * And `syns users`, to find someone. Nothing here needs more than the plugin's
 * oldest CLI (0.3.3).
 */

const ROLE: Schema = { type: "string", enum: ["admin", "write", "read"], maxLength: 5 };
/**
 * A user id, as the CLI's role and remove take it. A security guard, the one
 * restriction beyond the CLI's own (D60): the CLI puts the id in a URL path
 * and its HTTP client collapses `.` and `..` there, so `..` would address the
 * repository's own route. No `/` or `\` either.
 */
const id: Schema = { type: "string", minLength: 1, maxLength: 128, pattern: "^(?!\\.{1,2}$)[^/\\\\]+$" };
/** Paging inside the host's 10,000 nodes. */
const limit: Schema = { type: "integer", minimum: 1, maximum: 100 };
const offset: Schema = { type: "integer", minimum: 0 };

const USER: Schema = { type: "object", properties: { id: { type: "string" }, username: nullable("string"), name: nullable("string"), email: nullable("string"), image: nullable("string") }, required: ["id"] };
const COLLABORATOR: Schema = { type: "object", properties: group("collaborator", { user: USER, role: { type: "string" }, createdAt: nullable("string") }), required: ["user", "role"] };

const collaboratorsResult: Schema = { type: "object", properties: { total: { type: "integer" }, limit: { type: "integer" }, offset: { type: "integer" }, data: { type: "array", items: COLLABORATOR } }, required: ["total", "data"] };
export const collaborators: SimpleMethod = {
  name: "syns.collaborators",
  description: "Who has access to this repository, and each one's role, limit at a time from offset; total says how many. From a placed folder the CLI does not answer: bad_scope.",
  effect: "read",
  params: object({ limit, offset }),
  result: collaboratorsResult,
  maxRequestBytes: K64,
  maxResponseBytes: M1,
  notFound: NOT_FOUND,
  reasons: ["not_permitted"],
  command: (params) => ({ args: buildArgs("collaborators", { limit: params.limit, offset: params.offset }) }),
};

const addResult: Schema = { type: "object", properties: { added: { type: "boolean" }, target: { type: "string" }, role: { type: "string" } }, required: ["added", "target", "role"] };
export const collaboratorAdd: SimpleMethod = {
  name: "syns.collaboratorAdd",
  description: "Give a person, by Syns username or e-mail, a role on this repository. Reaches that person at once: only from the reader's own press on a control naming the person and the role.",
  effect: "contributed-write",
  sharing: true,
  params: object({ user: { type: "string", maxLength: 320 }, role: ROLE }, ["user", "role"]),
  result: addResult,
  maxRequestBytes: K64,
  maxResponseBytes: K64,
  notFound: NOT_FOUND,
  reasons: ["not_permitted", "no_such_user", "already_collaborator"],
  command: (params) => ({ args: buildArgs(["collaborators", "add"], { role: params.role }, [params.user]) }),
};

export const collaboratorRole: SimpleMethod = {
  name: "syns.collaboratorRole",
  description: "Change a collaborator's role, by the user id syns.collaborators answers. Only from the reader's own press on a control naming the person and the new role.",
  effect: "contributed-write",
  sharing: true,
  params: object({ id, role: ROLE }, ["id", "role"]),
  result: COLLABORATOR,
  maxRequestBytes: K64,
  maxResponseBytes: K64,
  notFound: NOT_FOUND,
  reasons: ["not_permitted"],
  command: (params) => ({ args: buildArgs(["collaborators", "role"], { role: params.role }, [params.id]) }),
};

const removeResult: Schema = { type: "object", properties: { removed: { type: "boolean" }, userId: { type: "string" } }, required: ["removed", "userId"] };
export const collaboratorRemove: SimpleMethod = {
  name: "syns.collaboratorRemove",
  description: "Take a collaborator off this repository, by the user id syns.collaborators answers. Only from the reader's own press on a control naming the person.",
  effect: "contributed-write",
  sharing: true,
  params: object({ id }, ["id"]),
  result: removeResult,
  maxRequestBytes: K64,
  maxResponseBytes: K64,
  notFound: NOT_FOUND,
  reasons: ["not_permitted"],
  // Without --yes the CLI waits on standard input, which a page cannot answer.
  command: (params) => ({ args: buildArgs(["collaborators", "remove"], { yes: true }, [params.id]) }),
};

const usersResult: Schema = { type: "object", properties: { data: { type: "array", items: { type: "object", properties: { id: { type: "string" }, username: { type: "string" }, name: nullable("string"), image: nullable("string") }, required: ["id", "username"] } } }, required: ["data"] };
export const users: SimpleMethod = {
  name: "syns.users",
  description: "Syns people whose handle or display name matches query, at most limit: id, username, name, image. For finding someone to share with.",
  effect: "read",
  params: object({ query: { type: "string", maxLength: 100 }, limit }, ["query"]),
  result: usersResult,
  maxRequestBytes: K64,
  maxResponseBytes: M1,
  notFound: NOT_FOUND,
  command: (params) => ({ args: buildArgs("users", { limit: params.limit }, [params.query]) }),
};
