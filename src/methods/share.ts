import { buildArgs } from "../cli.js";
import { K64, group, nullable, object, NOT_FOUND, type Schema, type SimpleMethod } from "../method.js";

/**
 * Sharing, and a scope's visibility (D49, D59): each method is one CLI command,
 * run in the page's scope folder, its JSON passed on. The folder commands name
 * `.`, the folder the run stands in; at a repository's root the CLI refuses
 * that, and `repo --visibility` is refused inside a placed folder: both come
 * back as bad_scope (HOST_FACTS §17). share and unshare need CLI 0.3.11, the
 * first to take `.` (HOST_FACTS §15); share --visibility came in 0.3.12.
 */

/** The repository record the CLI prints for a repository or a folder's identity, as far as a page needs it. */
const RECORD: Record<string, Schema> = group("record", {
  owner: { type: "string" },
  name: { type: "string" },
  visibility: { type: "string" },
  role: nullable("string"),
  sharedFolder: { type: "boolean" },
  status: { type: "string" },
  description: nullable("string"),
  heldIn: { type: ["object", "null"], properties: { owner: { type: "string" }, name: { type: "string" }, path: { type: "string" } } },
});
const FOLDER: Record<string, Schema> = { holder: { type: "string" }, path: { type: "string" } };
const result = (properties: Record<string, Schema>, required: string[]): Schema => ({ type: "object", properties, required });

/** The CLI checks a name itself (bad_name); the bound only keeps it an argument. */
const name: Schema = { type: "string", maxLength: 100 };
const visibility: Schema = { type: "string", enum: ["public", "private"], maxLength: 7 };
const FOLDER_ARG = ["."];

const shareInfoResult = result({ ...FOLDER, holderRole: nullable("string"), shared: { type: "boolean" }, offeredName: { type: "string" }, ...RECORD }, ["holder", "path", "shared"]);
export const shareInfo: SimpleMethod = {
  name: "syns.shareInfo",
  description: "Whether this placed folder is shared: its identity's record when it is, the name a share would offer when not, and the reader's holderRole. share . --show. At a repository's root: bad_scope.",
  effect: "read",
  minCli: "0.3.11",
  params: object({}),
  result: shareInfoResult,
  maxRequestBytes: K64,
  maxResponseBytes: K64,
  notFound: NOT_FOUND,
  reasons: ["not_permitted"],
  command: () => ({ args: buildArgs("share", { show: true }, FOLDER_ARG) }),
};

const shareResult = result({ ...RECORD, ...FOLDER, created: { type: "boolean" } }, ["owner", "name", "holder", "path", "created"]);
export const share: SimpleMethod = {
  name: "syns.share",
  description: "Share this placed folder under an identity of its own, named name or the CLI's offer. Already shared: created false. Reaches people at once: only from the reader's own press on a control saying so.",
  effect: "contributed-write",
  sharing: true,
  minCli: "0.3.11",
  params: object({ name }),
  result: shareResult,
  maxRequestBytes: K64,
  maxResponseBytes: K64,
  notFound: NOT_FOUND,
  reasons: ["bad_name", "name_taken", "not_permitted"],
  command: (params) => ({ args: buildArgs("share", { name: params.name }, FOLDER_ARG) }),
};

const unshareResult = result({ owner: { type: "string" }, name: { type: "string" }, ...FOLDER, unshared: { type: "boolean" }, retired: nullable("boolean") }, ["owner", "name", "holder", "path", "unshared"]);
export const unshare: SimpleMethod = {
  name: "syns.unshare",
  description: "Stop sharing this placed folder: all who reached it through the folder lose access; its identity retires unless the folder has a visibility of its own. Only from the reader's own press on a control saying so.",
  effect: "contributed-write",
  sharing: true,
  minCli: "0.3.11",
  params: object({}),
  result: unshareResult,
  maxRequestBytes: K64,
  maxResponseBytes: K64,
  notFound: NOT_FOUND,
  reasons: ["not_permitted"],
  // Without --yes the CLI waits on standard input, which a page cannot answer.
  command: () => ({ args: buildArgs("unshare", { yes: true }, FOLDER_ARG) }),
};

const folderVisibilityResult = result({ ...RECORD, ...FOLDER, created: { type: "boolean" } }, ["owner", "name", "visibility", "holder", "path"]);
export const folderVisibility: SimpleMethod = {
  name: "syns.folderVisibility",
  description: "Give this placed folder a visibility of its own. public: anyone, signed in or not, can find and read it. There is no way back to inheriting. Only from the reader's own press on a control saying exactly that.",
  effect: "contributed-write",
  sharing: true,
  minCli: "0.3.12",
  params: object({ visibility, name }, ["visibility"]),
  result: folderVisibilityResult,
  maxRequestBytes: K64,
  maxResponseBytes: K64,
  notFound: NOT_FOUND,
  reasons: ["bad_name", "name_taken", "not_permitted"],
  command: (params) => ({ args: buildArgs("share", { visibility: params.visibility, name: params.name }, FOLDER_ARG) }),
};

const repoVisibilityResult = result(RECORD, ["owner", "name", "visibility"]);
export const repoVisibility: SimpleMethod = {
  name: "syns.repoVisibility",
  description: "Set this repository's visibility, from its root. public: anyone, signed in or not, can find and read every file. In a placed folder: bad_scope. Only from the reader's own press on a control saying exactly that.",
  effect: "contributed-write",
  sharing: true,
  params: object({ visibility }, ["visibility"]),
  result: repoVisibilityResult,
  maxRequestBytes: K64,
  maxResponseBytes: K64,
  notFound: NOT_FOUND,
  reasons: ["not_permitted"],
  command: (params) => ({ args: buildArgs("repo", { visibility: params.visibility }) }),
};
