import { REASONS } from "../errors.js";
import { GROUPS, path, reasonsOf, version, type Method, type Schema } from "../method.js";

/**
 * The guide text (spec 04), within GUIDE_MAX. The prose is written for the
 * methods this version registers (S4.4); the method and error sections are
 * generated from the table, so they cannot disagree with the declaration
 * (S4.3). What the host's roster already prints for each method (effect,
 * bounds, description, reasons) is not repeated (D42, D56).
 */

/** 16 KiB, the host's bound, less 512 for the next method (S6.34). */
export const GUIDE_MAX = 16 * 1024 - 512;

const PROSE = `# Syns: the session's repository, from a page

## When this applies

Only when the session's folder is a Syns repository, or a folder placed in one. At load, look for \`syns.repo\` in \`context.get\` and call it. Absent, or \`unavailable\` / \`no_repo\`: say so on the page and keep the rest working. The page never names a repository, session or folder. Never show invented data in its place.

## A placed folder

A folder placed in a repository (a tool) is all the page sees: every \`path\` is counted from it; nothing outside is reachable. A document may also set a scope (\`threadPage.setScope\`): a placed folder of the session's own repository, holding its own identity file; its calls then answer for that folder alone. \`bad_scope\` refuses anything else: a plain folder, one below a placed folder, another checkout, a folder outside the session's, or any scope where the session's folder is no Syns repository. \`syns.repo\` adds \`holder\` (OWNER/NAME) and \`path\`: show those. \`owner\`, \`name\`, \`role\`, \`visibility\` and \`fileCount\` are the holder's; build no path or link from them. \`version\` is the holder's head, so \`syns.diff\` may list nothing. Once the CLI checks writes against the folder only, a write is \`stale_head\` only when the folder changed after \`base\`; before, any change to the holder. Writes publish to all who share the holder. \`syns.place { template, path }\` places a template as a new folder, always at the session's folder.

## Versions

\`version\` is a commit id, opaque: compare it, pass it back, show it to nobody. \`number\` is the same version for display. \`blob\` changes exactly when a file's content does.

## Loading a wiki

1. \`syns.ls { recursive: true }\`: every file with its \`blob\`, and the \`version\` listed. \`truncated: true\` means incomplete: list folder by folder.
2. \`syns.readMany { paths, version }\` in groups of up to 64, passing that \`version\`; follow \`deferred\` the same way. \`too_large\` carries \`size\` (the bound counts the text as JSON escapes it): read it with \`syns.read\`.

300 files: one \`syns.ls\` and about five \`syns.readMany\`, inside the shared 120 calls a minute. A \`syns.read\` window's lines are joined with \`\\n\`, without \`\\r\` or a final newline: to write a file back exactly, read it with \`syns.readMany\`.

## Staying current

Poll only \`syns.repo\`, with the host's \`watch\`. When its \`version\` differs from the one held, \`syns.diff { from }\` lists each changed path and \`status\` up to \`to.version\`; re-read those at \`to.version\`. There is no push.

\`syns.history\` says who changed what. A page's write has \`by.integration\` \`syns-pages\` and \`by.trigger\` \`page\`; then \`by.run\` is the session whose page made it. Others set \`by.run\` too: never read it alone as a page's. \`syns.revert\` records none.

## Writing

Every file write but \`syns.revert\` carries \`base\`, the \`version\` last read; the returned \`version\` is the next \`base\`. A new file: \`syns.write\` with \`create: true\`, which refuses rather than overwrite. \`changed: 0\`: nothing differed, or the path was gone; no version made. A request past a method's bound comes back from the bridge as \`invalid_response\`: split it. \`syns.revert\` has no stale check and no provenance: call \`syns.repo\` just before offering it, and say what it overwrites. A picture larger than 720 KiB goes in ordered pieces; \`bad_offset\`: send from \`detail.expected\`. Beside texts in one version: \`hold: true\`, then its \`upload\` in \`syns.commit\`.
`;

const SHARING = `## Sharing and people

Each method acts where the CLI acts, in the page's own scope. In a placed folder: \`syns.shareInfo\`, \`syns.share\`, \`syns.unshare\`, \`syns.folderVisibility\`, \`syns.enableChecks\`. At a repository's root: \`syns.repoVisibility\`. The collaborator methods act on the scope's people: in a shared placed folder its own (CLI 0.3.14; until shared, \`bad_scope\` saying to share first; older CLIs, \`bad_scope\`); at a root the **whole repository's**, so never offer root people for one folder. Elsewhere the CLI refuses: \`bad_scope\`; show controls only where they apply (\`syns.repo\`'s \`holder\`, \`syns.shareInfo\`'s \`shared\`). \`syns.collaboratorRole\` and \`syns.collaboratorRemove\` take the \`user.id\` that \`syns.collaborators\` answers; find someone with \`syns.users\`. Roles are the CLI's; a shared folder takes \`read\` or \`write\`.

They act at once, with no dialog, and reach other people. So:

- **Only from a control the reader presses for that action:** never on load, from a timer or \`watch\`, or chained after another call.
- **The control shows who gets what** before it is pressed: the person and the role, or everyone the folder reaches. \`admin\` can also share, change visibility and manage people: say so.
- **Public is labelled apart:** "anyone, signed in or not, can find and read this". Never a default; never one option in a list beside private. A public name beginning with a private holder's name shows that name: say so first.
- **\`syns.unshare\`** removes everyone who reached the folder through it; its name stays reserved.

Poll none of these with \`watch\`. Errors come back from the CLI: a refusal with no reason carries the CLI's own words as \`message\`.
`;

const CANNOT = `## What a page cannot do here

Choose a repository, or reach outside its scope. Read unpublished edits. Write a file without a \`base\`, but for \`syns.revert\`. Set a commit's provenance. Run any CLI command but the ones behind these methods: no login, upgrade, push, pull, sync, delete or fork.
`;


/** The guide's short names for JSON types, said once in the method section's opening. */
const SHORT: Record<string, string> = { integer: "int", boolean: "bool" };

/** A schema in one line, from the same object the host is sent. */
function render(schema: Schema, grouping = true): string {
  if (schema === path) return "path";
  if (schema.pattern === version.pattern) return Array.isArray(schema.type) ? "version|null" : "version";
  const types = Array.isArray(schema.type) ? (schema.type as string[]) : [schema.type as string];
  const one = (type: string): string => {
    if (type === "object") {
      const properties = (schema.properties ?? {}) as Record<string, Schema>;
      const required = (schema.required ?? []) as string[];
      // A key whose type is its own name (version, path) is written once.
      // A shared group of keys is written once, by name (D56).
      const grouped = [...GROUPS].filter(() => grouping).filter(([, keys]) => Object.entries(keys).every(([key, child]) => properties[key] === child));
      const inGroup = new Set(grouped.flatMap(([, keys]) => Object.keys(keys)));
      const fields = [...grouped.map(([name]) => `…${name}`), ...Object.entries(properties).filter(([key]) => !inGroup.has(key)).map(([key, child]) => { const type = render(child, grouping); return `${key}${required.includes(key) ? "" : "?"}${type === key ? "" : `: ${type}`}`; })];
      return fields.length > 0 ? `{ ${fields.join(", ")} }` : "{}";
    }
    if (type === "array") {
      const count = schema.minItems !== undefined || schema.maxItems !== undefined ? ` (${schema.minItems ?? 0}–${schema.maxItems ?? "…"})` : "";
      return `[${render(schema.items as Schema, grouping)}]${count}`;
    }
    if (Array.isArray(schema.enum)) return schema.enum.map((option) => JSON.stringify(option)).join("|");
    if (type === "string") return schema.maxLength !== undefined ? `string(≤${schema.maxLength})` : "string";
    if (type === "integer" && (schema.minimum !== undefined || schema.maximum !== undefined)) return `int(${schema.minimum ?? "…"}–${schema.maximum ?? "…"})`;
    return SHORT[type] ?? type;
  };
  return types.map(one).join("|");
}

function methodSection(table: readonly Method[]): string {
  const blocks = table.map((method) => [`### \`${method.name}\``, `- Params: \`${render(method.params)}\``, `- Result: \`${render(method.result)}\``].join("\n"));
  return `## Every method\n\nThe host's roster above (*Registered now*) gives each method's effect, bounds, description and every reason it may answer. \`path\` is counted from the repository's root, or the placed folder, with \`/\` separators, at most 1,024 characters; no leading \`/\` or \`-\`, no \`\\\` or control character, no \`.\` or \`..\` segment. A \`?\` marks an optional key; a bare \`version\` or \`path\` key has that type; no other key is accepted. ${[...GROUPS].map(([name, keys]) => `\`…${name}\` is \`${render({ type: "object", properties: keys }, false)}\`.`).join(" ")}\n\n${blocks.join("\n\n")}\n`;
}

function errorSection(table: readonly Method[]): string {
  const declared = [...new Set(table.flatMap(reasonsOf))];
  const rows = declared.map((reason) => `- \`${REASONS[reason].code}\` / \`${reason}\` — ${REASONS[reason].meaning}`);
  return `## Errors\n\nBranch on \`reason\` when there is one, else on \`code\`: \`conflict\` means re-read, \`unavailable\` means not now or not here, \`not_found\` means it is not there. \`message\` may be shown to the reader.\n\n${rows.join("\n")}\n- \`not_found\` — the path, the \`version\`, or what was named does not exist.\n- \`invalid_params\` — the parameters do not fit the method; fix the page.\n- \`response_too_large\` — ask for less.\n- \`handler_error\` — anything else; \`message\` holds the CLI's own words when it gave some.\n`;
}

export function buildGuide(table: readonly Method[]): string {
  return [PROSE, SHARING, methodSection(table), errorSection(table), CANNOT].join("\n").trim();
}
