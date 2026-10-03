import { buildArgs } from "../cli.js";
import { K64, nullable, object, version, type SimpleMethod } from "../method.js";

/** What the CLI reports in a placed folder, and may report at a root later: passed on only when present, and of its type (D34). */
const passed = (out: Record<string, unknown>): Record<string, unknown> => ({
  ...(Number.isInteger(out.version) || out.version === null ? { number: out.version } : {}),
  ...(typeof out.holder === "string" ? { holder: out.holder } : {}),
  ...(typeof out.path === "string" ? { path: out.path } : {}),
  ...(typeof out.sharedFolder === "boolean" ? { sharedFolder: out.sharedFolder } : {}),
});

export const repo: SimpleMethod = {
  name: "syns.repo",
  description: "The Syns repository of this session's folder, or the placed folder it is, and its head version. The method a page polls with watch: one cheap call.",
  effect: "read",
  params: object({}),
  result: {
    type: "object",
    properties: {
      owner: { type: "string" },
      name: { type: "string" },
      version: { ...version, type: ["string", "null"], description: "The head. null for a repository with no commit yet." },
      number: { ...nullable("integer"), description: "The head as a number, for display. Present where the CLI reports it: CLI 0.3.6 and later." },
      role: nullable("string"),
      visibility: { type: "string" },
      fileCount: { type: "integer" },
      holder: { type: "string", description: "In a placed folder: OWNER/NAME of the repository holding it. owner, name, role, visibility and fileCount are then the holder's." },
      path: { type: "string", description: "In a placed folder: its path in the holder. Every path a page uses is counted from it." },
      sharedFolder: { type: "boolean", description: "true in a folder-only collaborator's checkout of a shared folder: the record is the folder's identity, and fileCount is 0." },
    },
    required: ["owner", "name", "version", "role", "visibility", "fileCount"],
  },
  maxRequestBytes: K64,
  maxResponseBytes: K64,
  // Exactly one CLI process, because it is polled. S1.10
  command: () => ({ args: buildArgs("repo") }),
  shape: (out) => ({ owner: out.owner, name: out.name, version: out.commitSha ?? null, role: out.role ?? null, visibility: out.visibility, fileCount: out.fileCount, ...passed(out) }),
};
