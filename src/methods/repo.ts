import { buildArgs } from "../cli.js";
import { K64, nullable, object, version, type SimpleMethod } from "../method.js";

export const repo: SimpleMethod = {
  name: "syns.repo",
  description: "The Syns repository of this session's folder, and its head version. The method a page polls with watch: one cheap call.",
  effect: "read",
  params: object({}),
  result: {
    type: "object",
    properties: {
      owner: { type: "string" },
      name: { type: "string" },
      version: { ...version, type: ["string", "null"], description: "The head. null for a repository with no commit yet." },
      role: nullable("string"),
      visibility: { type: "string" },
      fileCount: { type: "integer" },
    },
    required: ["owner", "name", "version", "role", "visibility", "fileCount"],
  },
  maxRequestBytes: K64,
  maxResponseBytes: K64,
  // Exactly one CLI process, because it is polled. S1.10
  command: () => ({ args: buildArgs("repo") }),
  shape: (out) => ({ owner: out.owner, name: out.name, version: out.commitSha ?? null, role: out.role ?? null, visibility: out.visibility, fileCount: out.fileCount }),
};
