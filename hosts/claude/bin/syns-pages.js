import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { homedir, tmpdir } from "node:os";
import { delimiter, join, sep } from "node:path";
import { createHash } from "node:crypto";
import { access, constants, realpath, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
//#region src/cli.ts
const CLI_NOT_FOUND = "cli_not_found";
/** The host half's answer when a scoped cwd is not a Syns folder inside the session's folder, once symlinks are followed (D43, D46). */
const SCOPE_OUTSIDE = "scope_outside";
const LIMITS = {
	processMs: 2e4,
	callMs: 25e3,
	perMachine: 16,
	perCall: 8
};
/**
* The argument array of one CLI run: every option as `--option=value`, always
* `--json`, every positional after `--`. A value a page supplied can therefore
* never be read as a flag. A list repeats its option once for each value.
* S2.11, S2.13
*/
function buildArgs(verb, options = {}, positionals = []) {
	const args = typeof verb === "string" ? [verb] : [...verb];
	for (const [name, value] of Object.entries(options)) {
		if (value === void 0 || value === false) continue;
		if (typeof value === "object") args.push(...value.map((one) => `--${name}=${one}`));
		else args.push(value === true ? `--${name}` : `--${name}=${value}`);
	}
	args.push("--json");
	if (positionals.length > 0) args.push("--", ...positionals);
	return args;
}
const TIMED_OUT = {
	exitCode: null,
	stdout: "",
	stderr: "",
	timedOut: true,
	spawnError: null,
	overflowed: false
};
function createCli(runner, limits = LIMITS) {
	const machines = /* @__PURE__ */ new Map();
	return {
		limits,
		async run(where, args, stdin, deadline, env) {
			let machine = machines.get(where.hostId);
			if (!machine) machines.set(where.hostId, machine = {
				running: 0,
				waiting: []
			});
			const slots = machine;
			if (slots.running >= limits.perMachine) await new Promise((resolve) => slots.waiting.push(resolve));
			else slots.running += 1;
			try {
				const left = deadline - Date.now();
				if (left <= 0) return TIMED_OUT;
				const input = stdin === void 0 ? {} : typeof stdin === "string" ? { stdin } : { stdinBase64: stdin.toString("base64") };
				return await runner.run({
					hostId: where.hostId,
					cwd: where.cwd,
					...where.within ? { within: where.within } : {},
					args,
					...env ? { env } : {},
					...input,
					timeoutMs: Math.min(limits.processMs, left)
				});
			} finally {
				const next = slots.waiting.shift();
				if (next) next();
				else slots.running -= 1;
			}
		}
	};
}
/** `fn` over `items`, at most `size` at once, results in the order of `items`. */
async function pool(items, size, fn) {
	const out = new Array(items.length);
	let next = 0;
	const worker = async () => {
		while (next < items.length) {
			const index = next;
			next += 1;
			out[index] = await fn(items[index], index);
		}
	};
	await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
	return out;
}
//#endregion
//#region src/errors.ts
const SHA = {
	type: "string",
	pattern: "^[0-9a-f]{40}$",
	maxLength: 40
};
/** `LIM-file-size`: the most one file in Syns may hold (D-088, HOST_FACTS §12). */
const FILE_MAX = 26214400;
const REASONS = {
	no_repo: {
		code: "unavailable",
		message: "This session's folder is not a Syns repository.",
		meaning: "The session's folder holds no Syns repository, or the caller is the home page."
	},
	no_access: {
		code: "unavailable",
		message: "The Syns account on this session's machine cannot reach the repository, or is logged out.",
		meaning: "The machine's account cannot reach the repository, or is logged out."
	},
	not_logged_in: {
		code: "unavailable",
		message: "Nobody is logged in to Syns on this session's machine.",
		meaning: "No Syns login on that machine."
	},
	cli_missing: {
		code: "unavailable",
		message: "The Syns command-line tool was not found on this session's machine.",
		meaning: "No syns on that machine; an operator installs it or sets synsPath."
	},
	timeout: {
		code: "unavailable",
		message: "Syns did not answer in time. Try again.",
		meaning: "The CLI did not answer in time. Retry a read; after a write, re-read syns.repo first."
	},
	cli_too_old: {
		code: "unavailable",
		message: "The Syns command-line tool on this session's machine is too old for this. Run syns upgrade there.",
		meaning: "The machine's syns is older than detail.need (detail.have): syns upgrade there.",
		detail: {
			type: "object",
			properties: {
				need: { type: "string" },
				have: { type: ["string", "null"] }
			},
			required: ["need", "have"]
		}
	},
	folder_out_of_place: {
		code: "unavailable",
		message: "This session's folder is not where its repository records it, so Syns will not use it.",
		meaning: "A placed folder stands away from the path its identity file records; an operator moves it back."
	},
	folder_write_unsupported: {
		code: "unavailable",
		message: "The Syns server cannot take writes from inside a placed folder yet. Nothing was written.",
		meaning: "The server is too old for writes in a placed folder. Nothing written; reads work."
	},
	occupied: {
		code: "conflict",
		message: "That folder already holds files. Nothing was placed.",
		meaning: "path already holds a file at the head or on disk; choose another."
	},
	no_such_template: {
		code: "not_found",
		message: "That template does not exist, or this account cannot read it.",
		meaning: "template is no repository the reader can read."
	},
	bad_scope: {
		code: "invalid_params",
		message: "This page asked for something its folder cannot do here: it is not a placed folder of its session's repository, or this action needs another kind of folder.",
		meaning: "The scope is not a placed folder of the session's own repository, or the CLI does not act there: a folder action at a root, a holder action in a placed folder, a folder's people before it is shared."
	},
	stale_head: {
		code: "conflict",
		message: "The repository changed since this page last read it. Nothing was written.",
		meaning: "The repository, or placed folder, changed after base; nothing written; detail.current is the head. Re-read, show what changed, never retry blindly.",
		detail: {
			type: "object",
			properties: { current: SHA },
			required: ["current"]
		}
	},
	checkout_dirty: {
		code: "conflict",
		message: "An agent is working in this session's folder and has unpublished edits. Nothing was written; try again when its turn ends.",
		meaning: "The session's folder has unpublished edits, usually its agent mid-turn. Nothing written; retry when syns.repo's version moves."
	},
	exists: {
		code: "conflict",
		message: "A file is already there. Nothing was written.",
		meaning: "create was set and the path exists at base."
	},
	no_match: {
		code: "invalid_params",
		message: "The text to replace was not found in the file. Nothing was written.",
		meaning: "old occurs nowhere in the file."
	},
	many_matches: {
		code: "invalid_params",
		message: "The text to replace occurs more than once in the file. Nothing was written.",
		meaning: "old occurs detail.count times and replaceAll is not set.",
		detail: {
			type: "object",
			properties: { count: {
				type: "integer",
				minimum: 2
			} },
			required: ["count"]
		}
	},
	bad_pattern: {
		code: "invalid_params",
		message: "The search pattern could not be understood.",
		meaning: "The regular expression or glob does not parse."
	},
	bad_offset: {
		code: "conflict",
		message: "The picture's pieces did not arrive in order, or were dropped. Send it again from the offset expected.",
		meaning: "Send the piece at detail.expected; 0 means start again (pieces or an upload are dropped after a minute).",
		detail: {
			type: "object",
			properties: { expected: {
				type: "integer",
				minimum: 0
			} },
			required: ["expected"]
		}
	},
	bad_hash: {
		code: "invalid_params",
		message: "The picture that arrived is not the one described. Nothing was written.",
		meaning: "The gathered bytes do not match sha256; nothing published."
	},
	too_large: {
		code: "invalid_params",
		message: "The file is larger than one file in Syns may be. Nothing was written.",
		meaning: "Past detail.max bytes, the most one file may hold (25 MiB).",
		detail: {
			type: "object",
			properties: { max: { type: "integer" } },
			required: ["max"]
		}
	},
	bad_name: {
		code: "invalid_params",
		message: "That name cannot be used. Use lower-case letters, digits, dots, dashes and underscores.",
		meaning: "name breaks the repository-name rule."
	},
	name_taken: {
		code: "conflict",
		message: "That name is already taken. Nothing was shared.",
		meaning: "Another repository holds name; offer the reader another."
	},
	not_permitted: {
		code: "unavailable",
		message: "Syns refused this for this account: it may need a higher role, or a limit was reached.",
		meaning: "Syns answered 403 for this account: a role too low for it, or a server limit. The CLI says no more."
	},
	no_such_user: {
		code: "not_found",
		message: "There is no Syns user by that name or e-mail.",
		meaning: "user names nobody on Syns."
	},
	already_collaborator: {
		code: "conflict",
		message: "That person already has access to this folder.",
		meaning: "user already holds a grant here; nothing changed."
	},
	invalid_change: {
		code: "invalid_params",
		message: "The change names a path twice, or changes nothing. Nothing was written.",
		meaning: "A path named twice across files and deletions, or no change at all."
	}
};
/** bad_scope's sentence when the CLI says the placed folder is not shared yet (CLI 0.3.14, D63). */
const NOT_SHARED_YET = "This folder is not shared yet: share it first, then add people to it. If it was just shared, try again after the next sync.";
/** Sentences for failures that carry a code and no reason. */
const CODE_MESSAGES = {
	invalid_params: "The page sent parameters this method does not accept.",
	not_found: "That path or version does not exist in the repository.",
	conflict: "The repository changed. Nothing was written.",
	unavailable: "Syns is not available for this session right now.",
	handler_error: "Syns could not complete this. The plugin's log has the cause.",
	unknown_method: "The Syns plugin has no such method.",
	response_too_large: "The answer is too large to return. Ask for less at a time."
};
var SynsError = class extends Error {
	code;
	reason;
	detail;
	/** For the plugin's log only (S2.18). Never sent to a page. */
	log;
	/** Set on a not_found that is known to be about the version rather than a path. */
	subject;
	constructor(code, options = {}) {
		super(options.message ?? (options.reason ? REASONS[options.reason].message : CODE_MESSAGES[code]));
		this.code = code;
		if (options.reason) this.reason = options.reason;
		if (options.detail) this.detail = options.detail;
		if (options.log) this.log = options.log;
		if (options.subject) this.subject = options.subject;
	}
};
const fail = (reason, detail) => new SynsError(REASONS[reason].code, {
	reason,
	...detail ? { detail } : {}
});
function toAnswer(error) {
	return {
		ok: false,
		error: {
			code: error.code,
			message: error.message.slice(0, 300),
			...error.reason ? { reason: error.reason } : {},
			...error.detail ? { detail: error.detail } : {}
		}
	};
}
function parse(text) {
	try {
		return { value: JSON.parse(text) };
	} catch {
		return null;
	}
}
/** One path character: none of the white space, quotes and punctuation that end a path in a sentence. */
const PATH_CHAR = String.raw`[^\s'"` + "`" + String.raw`,;()\[\]]`;
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/**
* The CLI's words with local paths taken out, before they reach a page (D60,
* D61): the session's folder becomes `.`, and every other absolute path
* `<path>`, POSIX or Windows, a `file://` URL included. A quoted path is
* replaced whole, spaces and all. A template's code may send what it is shown
* elsewhere; a username and a folder layout are not its to send. The log keeps
* the raw text.
*/
function redact(text, where = {}) {
	let out = text;
	const folder = where.folder?.replace(/[\\/]+$/, "");
	if (folder && folder.length > 1) out = out.replace(new RegExp(`${escape(folder)}(?=[\\\\/]|$|[\\s'"\`,;:)\\]])`, "g"), ".");
	const absolute = String.raw`(?:file:\/\/|\/|[A-Za-z]:[\\/]|\\\\)`;
	return out.replace(new RegExp(String.raw`(['"` + "`" + String.raw`])${absolute}[^'"` + "`" + String.raw`\n]*\1`, "g"), (_, quote) => `${quote}<path>${quote}`).replace(new RegExp(String.raw`file:\/\/${PATH_CHAR}*`, "g"), "<path>").replace(new RegExp(String.raw`\\\\${PATH_CHAR}+`, "g"), "<path>").replace(new RegExp(String.raw`(?<![\w])[A-Za-z]:[\\/]${PATH_CHAR}*`, "g"), "<path>").replace(new RegExp(String.raw`(?<![\w.:/<\\])\/${PATH_CHAR}+`, "g"), "<path>");
}
async function interpret(run, declared, runRepo, where = {}) {
	if (run.spawnError !== null) {
		if (run.spawnError === "cli_not_found") throw fail("cli_missing");
		if (run.spawnError === "scope_outside") throw fail("bad_scope");
		throw new SynsError("handler_error", { log: `could not start: ${run.spawnError.slice(0, 500)}` });
	}
	if (run.timedOut) throw fail("timeout");
	if (run.overflowed) throw new SynsError("response_too_large");
	const parsed = parse(run.stdout);
	if (run.exitCode === 0) {
		if (!parsed) throw new SynsError("handler_error", { log: `exit=0 output is not JSON (${run.stdout.length} characters)` });
		return parsed.value;
	}
	const document = parsed && typeof parsed.value === "object" && parsed.value !== null ? parsed.value : {};
	const error = typeof document.error === "string" ? document.error : "";
	const exit = run.exitCode;
	if (exit === 7 && typeof document.currentSha === "string") throw fail("stale_head", { current: document.currentSha });
	if (exit === 2 && error.includes("cannot determine repo identity")) throw fail("no_repo");
	if (exit === 2 && error.startsWith("folder out of place")) throw fail("folder_out_of_place");
	if (exit === 1 && error.startsWith("folder_write_unsupported")) throw fail("folder_write_unsupported");
	if (exit === 1 && error.includes("holds unpublished local changes")) throw fail("checkout_dirty");
	if (exit === 1 && error.includes("authentication required")) throw fail(declared.includes("not_logged_in") ? "not_logged_in" : "no_access");
	if (exit === 1 && error.includes("--old matched no content")) throw fail("no_match");
	if (exit === 1 && error.startsWith("configuration error") && error.includes(" already holds ")) throw fail("occupied");
	if (exit === 1 && error.startsWith("not_found:") && error.includes("is no repository you can read")) throw fail("no_such_template");
	if (exit === 1 && error.includes("the folder path must name a folder")) throw fail("bad_scope");
	if (exit === 1 && error.includes("holds no folder placed from a template")) throw fail("bad_scope");
	if (exit === 2 && error.startsWith("holder root required") && error.includes("acts on a shared folder's own people")) throw new SynsError("invalid_params", {
		reason: "bad_scope",
		message: NOT_SHARED_YET
	});
	if (exit === 2 && error.startsWith("holder root required")) throw fail("bad_scope");
	if (exit === 1 && error.includes("configuration error: a name holds") && declared.includes("bad_name")) throw fail("bad_name");
	if (exit === 1 && error.includes("(403)")) throw fail(declared.includes("not_permitted") ? "not_permitted" : "no_access");
	if (exit === 1 && error.includes("no user '") && declared.includes("no_such_user")) throw fail("no_such_user");
	if (exit === 1 && error.includes("(409)") && declared.includes("name_taken")) throw fail("name_taken");
	if (exit === 1 && error.includes("(409)") && declared.includes("already_collaborator")) throw fail("already_collaborator");
	const times = exit === 1 ? /--old matched (\d+) times/.exec(error) : null;
	if (times) throw fail("many_matches", { count: Number(times[1]) });
	if (exit === 1 && error.includes("(404)")) {
		const repo = await runRepo();
		if (repo.exitCode === 0 && repo.spawnError === null && !repo.timedOut) throw new SynsError("not_found", where.notFound ? { message: where.notFound } : {});
		throw fail("no_access");
	}
	if (exit === 1 && error.includes("invalid pattern")) throw fail("bad_pattern");
	if (exit === 1 && error.startsWith("payload_too_large")) throw fail("too_large", { max: FILE_MAX });
	if (exit === 1 && error.includes("path not found at version")) throw new SynsError("not_found");
	if (exit === 1 && error.includes("version not found")) throw new SynsError("not_found", { subject: "version" });
	const words = redact(error.trim(), where);
	throw new SynsError("handler_error", {
		...words ? { message: words.slice(0, 300) } : {},
		log: `exit=${exit} output=${(run.stdout + run.stderr).trim().slice(0, 500)}`
	});
}
//#endregion
//#region src/method.ts
const K64 = 65536;
const M1 = 1048576;
/** Left for the host's envelope around a result: `{ v, id, ok, result }`, its id at most 96 characters. */
const ENVELOPE = 1024;
/** How many bytes a value takes on the wire: its JSON, where a quote or a newline in a text is two characters. */
const bytes = (value) => Buffer.byteLength(JSON.stringify(value), "utf8");
const EVERY_METHOD = [
	"no_repo",
	"no_access",
	"cli_missing",
	"timeout",
	"folder_out_of_place",
	"bad_scope"
];
/** Every write, syns.revert included: a placed folder's write against a server without folder writes (D38). */
const EVERY_CHANGE = ["folder_write_unsupported"];
const EVERY_WRITE = ["stale_head", "checkout_dirty"];
/** Every reason a method can answer with: the common ones, a write's, and its own. S3.2 */
const reasonsOf = (method) => [
	...EVERY_METHOD,
	...method.minCli ? ["cli_too_old"] : [],
	...fileWrite(method) ? EVERY_CHANGE : [],
	...fileWrite(method) && !method.unguarded ? EVERY_WRITE : [],
	...method.reasons ?? []
];
/** A write of a repository's files, as opposed to a sharing change (D41). */
const fileWrite = (method) => method.effect === "contributed-write" && !method.sharing;
/** A closed object. */
const object = (properties, required = []) => ({
	type: "object",
	additionalProperties: false,
	properties,
	required
});
/**
* S2.9: not empty, at most 1,024 characters, not beginning with `/` or `-`, no
* `\`, no control character, no segment equal to `.` or `..`.
*/
const path = {
	type: "string",
	minLength: 1,
	maxLength: 1024,
	pattern: "^(?![/-])(?!(?:.*/)?\\.{1,2}(?:/|$))[^\\\\\\u0000-\\u001f\\u007f-\\u009f]+$"
};
/** A commit SHA, opaque to the page (D12). */
const version = {
	type: "string",
	pattern: "^[0-9a-f]{40}$",
	maxLength: 40
};
/** The `version` the page last read; every write against a parent requires it. S1.4 */
const base = version;
/** S1.6 */
const message = {
	type: "string",
	maxLength: 500
};
const nullable = (type) => ({ type: [type, "null"] });
/** The provenance of a page's commit (D6, S1.5). A page can set none of the three. */
const provenance = (sessionId) => ({
	integration: "syns-bb-plugin",
	trigger: "thread-page",
	run: sessionId
});
const typeMatches = (type, value) => {
	switch (type) {
		case "object": return typeof value === "object" && value !== null && !Array.isArray(value);
		case "array": return Array.isArray(value);
		case "integer": return typeof value === "number" && Number.isSafeInteger(value);
		case "null": return value === null;
		default: return typeof value === type;
	}
};
/**
* The first way `value` fails `schema`, or null. The same subset, read the same
* way, as the host's own check; here it refuses bad parameters before any
* process runs, and refuses a CLI output with a hole in it (S3.7).
*/
function validate(schema, value, at = "$") {
	const types = schema.type === void 0 ? [] : Array.isArray(schema.type) ? schema.type : [schema.type];
	if (value === void 0) return `${at}: missing`;
	if (types.length > 0 && !types.some((type) => typeMatches(type, value))) return `${at}: expected ${types.join(" or ")}`;
	if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return `${at}: not one of the allowed values`;
	if (typeof value === "string") {
		if (typeof schema.minLength === "number" && value.length < schema.minLength) return `${at}: too short`;
		if (typeof schema.maxLength === "number" && value.length > schema.maxLength) return `${at}: too long`;
		if (typeof schema.pattern === "string" && !new RegExp(schema.pattern, "u").test(value)) return `${at}: not an accepted form`;
	} else if (typeof value === "number") {
		if (typeof schema.minimum === "number" && value < schema.minimum) return `${at}: below ${schema.minimum}`;
		if (typeof schema.maximum === "number" && value > schema.maximum) return `${at}: above ${schema.maximum}`;
	} else if (Array.isArray(value)) {
		if (typeof schema.minItems === "number" && value.length < schema.minItems) return `${at}: too few items`;
		if (typeof schema.maxItems === "number" && value.length > schema.maxItems) return `${at}: too many items`;
		for (let index = 0; index < value.length; index += 1) {
			const problem = validate(schema.items, value[index], `${at}[${index}]`);
			if (problem) return problem;
		}
	} else if (typeof value === "object" && value !== null) {
		const properties = schema.properties ?? {};
		const record = value;
		if (schema.additionalProperties === false) {
			const unknown = Object.keys(record).find((key) => !Object.hasOwn(properties, key));
			if (unknown !== void 0) return `${at}.${unknown}: unknown key`;
		}
		for (const key of schema.required ?? []) if (!Object.hasOwn(record, key) || record[key] === void 0) return `${at}.${key}: missing`;
		for (const [key, child] of Object.entries(properties)) {
			if (!Object.hasOwn(record, key) || record[key] === void 0) continue;
			const problem = validate(child, record[key], `${at}.${key}`);
			if (problem) return problem;
		}
	}
	return null;
}
/**
* Named groups of result keys several methods share, so the guide prints each
* once (D56): a result holding all of a group's keys, as the same schema
* objects, is written `…name` there.
*/
/** The not_found sentence of the methods that name no path or version (fix round 1, finding 3). */
const NOT_FOUND = "Syns answered that what this asked for is not there.";
const GROUPS = /* @__PURE__ */ new Map();
const group = (name, properties) => {
	GROUPS.set(name, properties);
	return properties;
};
/**
* The CLI's own JSON, kept to what `schema` names (S1.7): each named key whose
* value has a type the schema allows, objects and lists kept the same way.
* Nothing is renamed or made up; a key the CLI did not report stays absent,
* and the result's check (S3.7) refuses a required one that is missing.
*/
function pick(schema, value, at = "$", dropped) {
	const kept = keep$1(schema, value, at, dropped);
	if (kept === void 0 && value !== void 0) dropped?.push(at);
	return kept;
}
function keep$1(schema, value, at, dropped) {
	const types = schema.type === void 0 ? [] : Array.isArray(schema.type) ? schema.type : [schema.type];
	if (value === null) return types.includes("null") ? null : void 0;
	if (Array.isArray(value)) return types.includes("array") ? value.map((item, index) => pick(schema.items, item, `${at}[${index}]`, dropped)).filter((item) => item !== void 0) : void 0;
	if (typeof value === "object") {
		if (!types.includes("object")) return void 0;
		const properties = schema.properties ?? {};
		const record = value;
		const kept = {};
		for (const [key, child] of Object.entries(properties)) {
			if (!Object.hasOwn(record, key)) continue;
			const one = pick(child, record[key], `${at}.${key}`, dropped);
			if (one !== void 0) kept[key] = one;
		}
		return kept;
	}
	const type = typeof value === "number" && Number.isSafeInteger(value) && types.includes("integer") ? "integer" : typeof value;
	return types.includes(type) ? value : void 0;
}
//#endregion
//#region src/text/fragment.ts
/**
* The instruction fragment (spec 04): read by every eligible session, every
* time, on any host. It leads with the one line that matters most, a tool
* first (D35, D45), says in words when the rest applies (S4.2), names only
* methods this version registers (S4.4), and is declared to the host with the
* method list and injected nowhere else (S4.1). The declaration is the same on
* every host (07 R-X1), so the text names no host's command: the host's own
* instruction names its guide command under *More*. On bb the fragment
* reaches the agent before that instruction, so the text says where, not "above".
* The protocol allows 2,048 bytes.
*/
const FRAGMENT = `**Tool first.** Asked for a piece of work the person will keep working in? Look for a template first: \`syns explore -t syns-app -q <words>\`, then follow \`syns cat TOOLS.md --repo bartsoj/syns-templates\`.

**Syns repository.** When this session's folder is a Syns repository, or a folder placed in one, the page reads and writes it through \`syns.*\`. Not in \`context.get\`, or \`unavailable\` / \`no_repo\`: say so and keep the rest working; never show invented data.

- **The page names no repository:** it sees the one, or the placed folder, its session's folder belongs to; paths count from there.
- **Pages show pushed state:** your edits reach the page after your turn is pushed.
- **Every write needs \`base\`,** the \`version\` last read from \`syns.repo\`. On \`stale_head\`, re-read and let the reader retry; on \`checkout_dirty\` an agent is mid-turn: retry when \`version\` moves.
- **Load with \`syns.ls\` and \`syns.readMany\`;** poll only \`syns.repo\` with \`watch\`. Writes and shares act at once: only from a control saying what changes, for whom.

Every method: the page guide (its command is in your page instruction's *More*), section *Capabilities from contributors*. Installing or diagnosing the plugin: \`syns cat SETUP.md --repo bartsoj/syns-bb-plugin-setup\`.
`;
//#endregion
//#region src/text/guide.ts
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

\`syns.history\` says who changed what. A page's write has \`by.integration\` \`syns-bb-plugin\` and \`by.trigger\` \`thread-page\`; then \`by.run\` is the session whose page made it. Others set \`by.run\` too: never read it alone as a page's. \`syns.revert\` records none.

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
const SHORT = {
	integer: "int",
	boolean: "bool"
};
/** A schema in one line, from the same object the host is sent. */
function render(schema, grouping = true) {
	if (schema === path) return "path";
	if (schema.pattern === version.pattern) return Array.isArray(schema.type) ? "version|null" : "version";
	const types = Array.isArray(schema.type) ? schema.type : [schema.type];
	const one = (type) => {
		if (type === "object") {
			const properties = schema.properties ?? {};
			const required = schema.required ?? [];
			const grouped = [...GROUPS].filter(() => grouping).filter(([, keys]) => Object.entries(keys).every(([key, child]) => properties[key] === child));
			const inGroup = new Set(grouped.flatMap(([, keys]) => Object.keys(keys)));
			const fields = [...grouped.map(([name]) => `…${name}`), ...Object.entries(properties).filter(([key]) => !inGroup.has(key)).map(([key, child]) => {
				const type = render(child, grouping);
				return `${key}${required.includes(key) ? "" : "?"}${type === key ? "" : `: ${type}`}`;
			})];
			return fields.length > 0 ? `{ ${fields.join(", ")} }` : "{}";
		}
		if (type === "array") {
			const count = schema.minItems !== void 0 || schema.maxItems !== void 0 ? ` (${schema.minItems ?? 0}–${schema.maxItems ?? "…"})` : "";
			return `[${render(schema.items, grouping)}]${count}`;
		}
		if (Array.isArray(schema.enum)) return schema.enum.map((option) => JSON.stringify(option)).join("|");
		if (type === "string") return schema.maxLength !== void 0 ? `string(≤${schema.maxLength})` : "string";
		if (type === "integer" && (schema.minimum !== void 0 || schema.maximum !== void 0)) return `int(${schema.minimum ?? "…"}–${schema.maximum ?? "…"})`;
		return SHORT[type] ?? type;
	};
	return types.map(one).join("|");
}
function methodSection(table) {
	const blocks = table.map((method) => [
		`### \`${method.name}\``,
		`- Params: \`${render(method.params)}\``,
		`- Result: \`${render(method.result)}\``
	].join("\n"));
	return `## Every method\n\nThe host's roster above (*Registered now*) gives each method's effect, bounds, description and every reason it may answer. \`path\` is counted from the repository's root, or the placed folder, with \`/\` separators, at most 1,024 characters; no leading \`/\` or \`-\`, no \`\\\` or control character, no \`.\` or \`..\` segment. A \`?\` marks an optional key; a bare \`version\` or \`path\` key has that type; no other key is accepted. ${[...GROUPS].map(([name, keys]) => `\`…${name}\` is \`${render({
		type: "object",
		properties: keys
	}, false)}\`.`).join(" ")}\n\n${blocks.join("\n\n")}\n`;
}
function errorSection(table) {
	return `## Errors\n\nBranch on \`reason\` when there is one, else on \`code\`: \`conflict\` means re-read, \`unavailable\` means not now or not here, \`not_found\` means it is not there. \`message\` may be shown to the reader.\n\n${[...new Set(table.flatMap(reasonsOf))].map((reason) => `- \`${REASONS[reason].code}\` / \`${reason}\` — ${REASONS[reason].meaning}`).join("\n")}\n- \`not_found\` — the path, the \`version\`, or what was named does not exist.\n- \`invalid_params\` — the parameters do not fit the method; fix the page.\n- \`response_too_large\` — ask for less.\n- \`handler_error\` — anything else; \`message\` holds the CLI's own words when it gave some.\n`;
}
function buildGuide(table) {
	return [
		PROSE,
		SHARING,
		methodSection(table),
		errorSection(table),
		CANNOT
	].join("\n").trim();
}
//#endregion
//#region src/declaration.ts
/** The plugin's version, as declared to the host. A test holds it equal to package.json's. */
const VERSION = "0.7.0-rc.3";
/** threadPagesContributions, generated from the table. With `agentInstructions` off no fragment is declared (S4.5). */
function buildDeclaration(table, settings) {
	return {
		version: VERSION,
		methods: table.map((method) => ({
			name: method.name,
			description: method.description,
			effect: method.effect,
			params: method.params,
			result: method.result,
			maxRequestBytes: method.maxRequestBytes,
			maxResponseBytes: method.maxResponseBytes,
			reasons: Object.fromEntries(reasonsOf(method).map((reason) => {
				const entry = REASONS[reason];
				return [reason, {
					description: entry.meaning,
					...entry.detail ? { detail: entry.detail } : {}
				}];
			}))
		})),
		...settings.agentInstructions ? { instruction: FRAGMENT.trim() } : {},
		guide: buildGuide(table)
	};
}
//#endregion
//#region src/held.ts
/**
* What the server half holds between calls (D24–D27): a picture being gathered
* piece by piece, and a picture's bytes being handed out piece by piece. Memory
* only, never a file. Each entry is dropped a minute after it was last touched;
* all of them together hold at most 64 MiB, the oldest dropped first to make
* room; a session gathers at most two pictures at once.
*/
const HELD_TOTAL = 67108864;
const HELD_IDLE_MS = 6e4;
function createHeld(now = Date.now, total = HELD_TOTAL, idleMs = HELD_IDLE_MS) {
	const entries = /* @__PURE__ */ new Map();
	const sweep = () => {
		const cutoff = now() - idleMs;
		for (const [key, entry] of entries) if (entry.touched < cutoff) entries.delete(key);
	};
	const used = () => [...entries.values()].reduce((sum, entry) => sum + entry.reserved, 0);
	return {
		get(key) {
			sweep();
			const entry = entries.get(key);
			if (!entry) return void 0;
			entry.touched = now();
			entries.delete(key);
			entries.set(key, entry);
			return entry;
		},
		put(key, value, reserved) {
			sweep();
			entries.delete(key);
			for (const [other] of entries) {
				if (used() + reserved <= total) break;
				entries.delete(other);
			}
			entries.set(key, Object.assign(value, {
				touched: now(),
				reserved
			}));
		},
		drop(key) {
			entries.delete(key);
		},
		gathering(session) {
			sweep();
			return [...entries.entries()].filter(([, entry]) => entry.kind === "upload" && entry.session === session && !entry.complete).map(([key]) => key);
		},
		used
	};
}
//#endregion
//#region src/methods/binary.ts
/**
* Pictures (D23–D27, roadmap 212, D-088). Bytes cross the bridge as base64, at
* most PIECE bytes a call either way, so a piece and its fields fit one 1 MiB
* call. A larger picture is read, or gathered for a write, piece by piece; the
* plugin holds it in memory between calls (held.ts).
*/
/** 720 KiB: 983,040 characters of base64, a multiple of three bytes so no piece carries padding but the last. */
const PIECE = 737280;
/** Base64, whole groups of four, padding only at the end. */
const base64 = {
	type: "string",
	maxLength: PIECE / 3 * 4,
	pattern: "^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$"
};
const sha256 = {
	type: "string",
	pattern: "^[0-9a-f]{64}$",
	maxLength: 64
};
const hash = (data) => createHash("sha256").update(data).digest("hex");
const record$7 = (value) => typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
/** Held keys: a picture read, one being gathered, one gathered whole and kept for syns.commit. */
const readKey = (session, at, file) => `read|${session}|${at}|${file}`;
const gatherKey = (session, file, parent, digest) => `gather|${session}|${file}|${parent}|${digest}`;
const keptKey = (session, digest) => `kept|${session}|${digest}`;
const readBinary = {
	name: "syns.readBinary",
	description: "One file's bytes as base64 in pieces of up to 720 KiB, at version (default head). Follow nextOffset with the first piece's version until it is null.",
	effect: "read",
	params: object({
		path,
		version,
		offset: {
			type: "integer",
			minimum: 0,
			maximum: FILE_MAX
		}
	}, ["path"]),
	result: {
		type: "object",
		properties: {
			version,
			number: { type: "integer" },
			path: { type: "string" },
			size: { type: "integer" },
			blob: { type: "string" },
			mediaType: nullable("string"),
			sha256,
			offset: { type: "integer" },
			base64: { type: "string" },
			nextOffset: nullable("integer")
		},
		required: [
			"version",
			"number",
			"path",
			"size",
			"blob",
			"mediaType",
			"sha256",
			"offset",
			"base64",
			"nextOffset"
		]
	},
	maxRequestBytes: K64,
	maxResponseBytes: M1,
	check(params) {
		if ((params.offset ?? 0) > 0 && params.version === void 0) throw new SynsError("invalid_params", { message: "Invalid parameters for syns.readBinary: a later piece needs the version of the first" });
	},
	async procedure(params, context) {
		let held = params.version === void 0 ? void 0 : context.held.get(readKey(context.sessionId, params.version, params.path));
		if (!held) {
			const out = record$7(await context.syns(buildArgs("cat", { version: params.version }, [params.path])));
			const data = typeof out.contentBase64 === "string" ? Buffer.from(out.contentBase64, "base64") : typeof out.content === "string" ? Buffer.from(out.content, "utf8") : null;
			if (!data || typeof out.commitSha !== "string") throw new SynsError("handler_error", { log: "exit=0 cat carries neither content nor contentBase64" });
			held = {
				kind: "read",
				bytes: data,
				version: out.commitSha,
				number: out.version,
				path: params.path,
				blob: out.sha,
				mediaType: typeof out.mediaType === "string" ? out.mediaType : null,
				sha256: hash(data)
			};
			context.held.put(readKey(context.sessionId, held.version, params.path), held, data.length);
		}
		const offset = params.offset ?? 0;
		if (offset > held.bytes.length) throw new SynsError("invalid_params", { message: `Invalid parameters for syns.readBinary: offset is past the file's ${held.bytes.length} bytes` });
		const end = Math.min(offset + PIECE, held.bytes.length);
		return {
			version: held.version,
			number: held.number,
			path: held.path,
			size: held.bytes.length,
			blob: held.blob,
			mediaType: held.mediaType,
			sha256: held.sha256,
			offset,
			base64: held.bytes.subarray(offset, end).toString("base64"),
			nextOffset: end < held.bytes.length ? end : null
		};
	}
};
/** `write --bytes` against base, the page's provenance, the bytes on standard input. */
async function publish(params, data, context) {
	const args = buildArgs("write", {
		bytes: true,
		parent: params.base,
		message: params.message || `Write ${params.path} from a page`.slice(0, 500),
		...provenance(context.sessionId)
	}, [params.path]);
	const out = record$7(await context.syns(args, data));
	return {
		complete: true,
		received: data.length,
		version: out.commitSha,
		number: out.version,
		changed: out.filesChanged
	};
}
/** Keep a gathered picture for a syns.commit that names it by its sha256 (D26). */
function keep(params, data, digest, context) {
	const kept = {
		kind: "upload",
		session: context.sessionId,
		path: params.path,
		base: params.base,
		size: data.length,
		sha256: digest,
		chunks: [data],
		received: data.length,
		complete: true
	};
	context.held.put(keptKey(context.sessionId, digest), kept, data.length);
	return {
		complete: true,
		received: data.length,
		upload: digest
	};
}
const writeBinary = {
	name: "syns.writeBinary",
	description: "Store a file's bytes against base: whole up to 720 KiB, or in ordered pieces with offset, size and sha256, published after the last. hold: true keeps it for syns.commit.",
	effect: "contributed-write",
	params: object({
		path,
		base64,
		base,
		message,
		offset: {
			type: "integer",
			minimum: 0,
			maximum: FILE_MAX
		},
		size: {
			type: "integer",
			minimum: 0,
			maximum: 2 * FILE_MAX
		},
		sha256,
		hold: { type: "boolean" }
	}, [
		"path",
		"base64",
		"base"
	]),
	result: {
		type: "object",
		properties: {
			complete: {
				type: "boolean",
				description: "false: send the piece at received. true: published (version, number, changed), or kept (upload)."
			},
			received: { type: "integer" },
			version,
			number: { type: "integer" },
			changed: { type: "integer" },
			upload: sha256
		},
		required: ["complete", "received"]
	},
	maxRequestBytes: M1,
	maxResponseBytes: K64,
	reasons: [
		"bad_offset",
		"bad_hash",
		"too_large"
	],
	check(params) {
		const given = [
			params.offset,
			params.size,
			params.sha256
		].filter((value) => value !== void 0).length;
		if (given !== 0 && given !== 3) throw new SynsError("invalid_params", { message: "Invalid parameters for syns.writeBinary: a piece carries offset, size and sha256 together" });
		if (params.size !== void 0 && params.size > 26214400) throw fail("too_large", { max: FILE_MAX });
	},
	async procedure(params, context) {
		const piece = Buffer.from(params.base64, "base64");
		if (params.offset === void 0) {
			if (params.hold === true) return keep(params, piece, hash(piece), context);
			return publish(params, piece, context);
		}
		const size = params.size;
		const digest = params.sha256;
		const key = gatherKey(context.sessionId, params.path, params.base, digest);
		let gathering;
		if (params.offset === 0) {
			context.held.drop(key);
			const others = context.held.gathering(context.sessionId);
			for (const other of others.slice(0, Math.max(0, others.length - 2 + 1))) context.held.drop(other);
			gathering = {
				kind: "upload",
				session: context.sessionId,
				path: params.path,
				base: params.base,
				size,
				sha256: digest,
				chunks: [],
				received: 0,
				complete: false
			};
			context.held.put(key, gathering, size);
		} else {
			gathering = context.held.get(key);
			if (!gathering || gathering.received !== params.offset) throw fail("bad_offset", { expected: gathering?.received ?? 0 });
		}
		if (gathering.received + piece.length > size) {
			context.held.drop(key);
			throw new SynsError("invalid_params", { message: "Invalid parameters for syns.writeBinary: the pieces are longer than size" });
		}
		gathering.chunks.push(piece);
		gathering.received += piece.length;
		if (gathering.received < size) return {
			complete: false,
			received: gathering.received
		};
		context.held.drop(key);
		const data = Buffer.concat(gathering.chunks);
		if (hash(data) !== digest) throw fail("bad_hash");
		if (params.hold === true) return keep(params, data, digest, context);
		return publish(params, data, context);
	}
};
//#endregion
//#region src/methods/commit.ts
const pathsOf = (params) => [...(params.files ?? []).map((file) => file.path), ...params.deletions ?? []];
const record$6 = (value) => typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
const commit = {
	name: "syns.commit",
	description: "Several changes as one new version against base, all or nothing: files, each with text, base64 bytes, or an upload held by syns.writeBinary, and deletions. No path twice. Published at once.",
	effect: "contributed-write",
	params: object({
		base,
		message,
		files: {
			type: "array",
			maxItems: 64,
			items: object({
				path,
				text: {
					type: "string",
					maxLength: M1
				},
				base64,
				upload: sha256
			}, ["path"])
		},
		deletions: {
			type: "array",
			maxItems: 64,
			items: path
		}
	}, ["base"]),
	result: {
		type: "object",
		properties: {
			version,
			number: { type: "integer" },
			changed: {
				type: "integer",
				description: "How many paths the new version changed. 0: nothing differed, and version is the unchanged head."
			}
		},
		required: [
			"version",
			"number",
			"changed"
		]
	},
	maxRequestBytes: M1,
	maxResponseBytes: K64,
	reasons: ["invalid_change", "bad_offset"],
	check(params) {
		for (const file of params.files ?? []) if ([
			file.text,
			file.base64,
			file.upload
		].filter((value) => value !== void 0).length !== 1) throw new SynsError("invalid_params", { message: "Invalid parameters for syns.commit: each file carries exactly one of text, base64 and upload" });
		const paths = pathsOf(params);
		if (paths.length === 0 || new Set(paths).size !== paths.length) throw fail("invalid_change");
	},
	pathCount: (params) => pathsOf(params).length,
	async procedure(params, context) {
		const used = [];
		const files = (params.files ?? []).map((file) => {
			if (file.text !== void 0) return {
				path: file.path,
				content: file.text
			};
			if (file.base64 !== void 0) return {
				path: file.path,
				contentBase64: file.base64
			};
			const key = keptKey(context.sessionId, file.upload);
			const kept = context.held.get(key);
			if (!kept) throw fail("bad_offset", { expected: 0 });
			used.push(key);
			return {
				path: file.path,
				contentBase64: Buffer.concat(kept.chunks).toString("base64")
			};
		});
		const paths = pathsOf(params);
		const fallback = `Commit ${paths.length === 1 ? paths[0] : `${paths.length} paths`} from a page`.slice(0, 500);
		const stdin = JSON.stringify({
			files,
			deletions: (params.deletions ?? []).map((deleted) => ({ path: deleted }))
		});
		const out = record$6(await context.syns(buildArgs("commit", {
			parent: params.base,
			message: params.message || fallback,
			...provenance(context.sessionId)
		}), stdin));
		for (const key of used) context.held.drop(key);
		return {
			version: out.commitSha,
			number: out.version,
			changed: out.filesChanged
		};
	}
};
//#endregion
//#region src/methods/diff.ts
const record$5 = (value) => typeof value === "object" && value !== null ? value : {};
const end = {
	type: "object",
	properties: {
		version,
		number: { type: "integer" }
	},
	required: ["version", "number"]
};
const diff = {
	name: "syns.diff",
	description: "The net change between two versions: each changed path with its status (added, modified, deleted). to defaults to the head. patch: true adds each file's patch text. After the head moves, diff { from } says which files to re-read.",
	effect: "read",
	params: object({
		from: version,
		to: version,
		patch: { type: "boolean" }
	}, ["from"]),
	result: {
		type: "object",
		properties: {
			from: end,
			to: end,
			files: {
				type: "array",
				items: {
					type: "object",
					properties: {
						path: { type: "string" },
						status: { type: "string" },
						patch: { type: "string" }
					},
					required: ["path", "status"]
				}
			}
		},
		required: [
			"from",
			"to",
			"files"
		]
	},
	maxRequestBytes: K64,
	maxResponseBytes: M1,
	async procedure(params, context) {
		let to = params.to;
		if (to === void 0) {
			const head = (await context.syns(buildArgs("repo")))?.commitSha;
			if (typeof head !== "string") throw new SynsError("not_found");
			to = head;
		}
		const out = record$5(await context.syns(buildArgs("diff", {
			from: params.from,
			to
		})));
		const ends = [record$5(out.from), record$5(out.to)].map((one) => ({
			version: one.sha,
			number: one.version
		}));
		return {
			from: ends[0],
			to: ends[1],
			files: Array.isArray(out.files) ? out.files.map(record$5).map((file) => ({
				path: file.path,
				status: file.status,
				...params.patch === true && typeof file.diff === "string" ? { patch: file.diff } : {}
			})) : void 0
		};
	}
};
//#endregion
//#region src/methods/edit.ts
const MAX_TEXT = 32768;
const NO_NUL = "^[^\\u0000]*$";
const record$4 = (value) => typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
const edit = {
	name: "syns.edit",
	description: "Replace old with new in one file, as a new version made against base. old must occur exactly once unless replaceAll is true. old equal to new changes nothing: changed 0. Both at most 32,768 characters.",
	effect: "contributed-write",
	params: object({
		path,
		old: {
			type: "string",
			minLength: 1,
			maxLength: MAX_TEXT,
			pattern: NO_NUL
		},
		new: {
			type: "string",
			maxLength: MAX_TEXT,
			pattern: NO_NUL
		},
		replaceAll: { type: "boolean" },
		base,
		message
	}, [
		"path",
		"old",
		"new",
		"base"
	]),
	result: {
		type: "object",
		properties: {
			version,
			number: { type: "integer" },
			changed: {
				type: "integer",
				description: "How many paths the new version changed. 0: old equals new, and version is the unchanged head."
			}
		},
		required: [
			"version",
			"number",
			"changed"
		]
	},
	maxRequestBytes: 131072,
	maxResponseBytes: K64,
	reasons: ["no_match", "many_matches"],
	async procedure(params, context) {
		if (params.old === params.new) {
			const newest = record$4(record$4(await context.syns(buildArgs("history", { limit: 1 }))).data?.[0]);
			if (typeof newest.sha !== "string" || typeof newest.version !== "number") throw new SynsError("handler_error", { log: "exit=0 history names no head" });
			if (newest.sha !== params.base) throw fail("stale_head", { current: newest.sha });
			return {
				version: newest.sha,
				number: newest.version,
				changed: 0
			};
		}
		const out = record$4(await context.syns(buildArgs("edit", {
			old: params.old,
			new: params.new,
			"replace-all": params.replaceAll === true,
			parent: params.base,
			message: params.message || `Edit ${params.path} from a page`.slice(0, 500),
			...provenance(context.sessionId)
		}, [params.path])));
		return {
			version: out.commitSha,
			number: out.version,
			changed: out.filesChanged
		};
	}
};
//#endregion
//#region src/methods/glob.ts
const PAGE$1 = 2e3;
const record$3 = (value) => typeof value === "object" && value !== null ? value : {};
const glob = {
	name: "syns.glob",
	description: "The files whose whole path matches a glob pattern such as notes/**/*.md, under path (default root), at version (default head). No match: an empty list. Paged: up to 2000 from offset; nextOffset is null on the last page.",
	effect: "read",
	params: object({
		pattern: {
			type: "string",
			minLength: 1,
			maxLength: 512
		},
		path,
		version,
		offset: {
			type: "integer",
			minimum: 0
		},
		limit: {
			type: "integer",
			minimum: 1,
			maximum: PAGE$1
		}
	}, ["pattern"]),
	result: {
		type: "object",
		properties: {
			version,
			number: { type: "integer" },
			truncated: { type: "boolean" },
			total: { type: "integer" },
			nextOffset: nullable("integer"),
			matches: {
				type: "array",
				items: {
					type: "object",
					properties: {
						path: { type: "string" },
						size: { type: "integer" },
						blob: { type: "string" }
					},
					required: [
						"path",
						"size",
						"blob"
					]
				}
			}
		},
		required: [
			"version",
			"number",
			"truncated",
			"total",
			"nextOffset",
			"matches"
		]
	},
	maxRequestBytes: K64,
	maxResponseBytes: M1,
	reasons: ["bad_pattern"],
	command: (params) => ({ args: buildArgs("glob", {
		path: params.path,
		version: params.version
	}, [params.pattern]) }),
	shape: (out, params) => {
		const all = Array.isArray(out.matches) ? out.matches.map(record$3) : void 0;
		const offset = params.offset ?? 0;
		const end = offset + (params.limit ?? PAGE$1);
		return {
			version: out.commitSha,
			number: out.version,
			truncated: out.truncated,
			total: all?.length,
			nextOffset: all === void 0 ? void 0 : end < all.length ? end : null,
			matches: all?.slice(offset, end).map((match) => ({
				path: match.path,
				size: match.size,
				blob: match.sha
			}))
		};
	}
};
//#endregion
//#region src/methods/grep.ts
const record$2 = (value) => typeof value === "object" && value !== null ? value : {};
const rows = (value) => Array.isArray(value) ? value.map(record$2) : void 0;
const lineAndText = {
	type: "object",
	properties: {
		line: { type: "integer" },
		text: { type: "string" }
	},
	required: ["line", "text"]
};
const mostRows = (params) => (params.output ?? "content") === "content" ? Math.min(1e3, Math.floor(9e3 / (5 + 6 * (params.context ?? 0)))) : 1e3;
const grep = {
	name: "syns.grep",
	description: "Search file texts with a regular expression, under path, in files matching glob, at version (default head). output: content (default: matches with line and context), files, or count. headLimit caps rows (default 200, less with context)",
	effect: "read",
	params: object({
		pattern: {
			type: "string",
			minLength: 1,
			maxLength: 512
		},
		path,
		glob: {
			type: "array",
			maxItems: 8,
			items: {
				type: "string",
				minLength: 1,
				maxLength: 512
			}
		},
		ignoreCase: { type: "boolean" },
		context: {
			type: "integer",
			minimum: 0,
			maximum: 10,
			description: "Lines either side of each match. Only with output content."
		},
		output: {
			type: "string",
			enum: [
				"content",
				"files",
				"count"
			],
			maxLength: 7
		},
		headLimit: {
			type: "integer",
			minimum: 1,
			maximum: 1e3
		},
		version
	}, ["pattern"]),
	result: {
		type: "object",
		description: "Beside the common keys, exactly one of matches, files and counts: the one output names.",
		properties: {
			version,
			number: { type: "integer" },
			output: {
				type: "string",
				enum: [
					"content",
					"files",
					"count"
				]
			},
			truncated: { type: "boolean" },
			skipped: {
				type: "array",
				items: {
					type: "object",
					properties: {
						path: { type: "string" },
						reason: { type: "string" }
					},
					required: ["path", "reason"]
				}
			},
			matches: {
				type: "array",
				items: {
					type: "object",
					properties: {
						path: { type: "string" },
						line: { type: "integer" },
						text: { type: "string" },
						context: {
							type: "array",
							items: lineAndText
						}
					},
					required: [
						"path",
						"line",
						"text",
						"context"
					]
				}
			},
			files: {
				type: "array",
				items: { type: "string" }
			},
			counts: {
				type: "array",
				items: {
					type: "object",
					properties: {
						path: { type: "string" },
						count: { type: "integer" }
					},
					required: ["path", "count"]
				}
			}
		},
		required: [
			"version",
			"number",
			"output",
			"truncated",
			"skipped"
		]
	},
	maxRequestBytes: K64,
	maxResponseBytes: M1,
	reasons: ["bad_pattern"],
	check(params) {
		if ((params.headLimit ?? 0) > mostRows(params)) throw new SynsError("invalid_params", { message: `Invalid parameters for syns.grep: with this output and context, headLimit can be at most ${mostRows(params)}` });
		if ((params.context ?? 0) > 0 && (params.output ?? "content") !== "content") throw new SynsError("invalid_params", { message: "Invalid parameters for syns.grep: context applies only with output content" });
	},
	command(params) {
		const content = (params.output ?? "content") === "content";
		return { args: buildArgs("grep", {
			path: params.path,
			glob: params.glob,
			"ignore-case": params.ignoreCase === true,
			"line-number": content,
			context: content && params.context ? params.context : void 0,
			output: params.output ?? "content",
			"head-limit": params.headLimit ?? Math.min(200, mostRows(params)),
			version: params.version
		}, [params.pattern]) };
	},
	shape(out) {
		const common = {
			version: out.commitSha,
			number: out.version,
			output: out.output,
			truncated: out.truncated,
			skipped: rows(out.skipped)?.map((skip) => ({
				path: skip.path,
				reason: skip.reason
			}))
		};
		const found = out.output === "files" ? { files: Array.isArray(out.files) ? out.files : void 0 } : out.output === "count" ? { counts: rows(out.counts)?.map((count) => ({
			path: count.path,
			count: count.count
		})) } : { matches: rows(out.matches)?.map((match) => ({
			path: match.path,
			line: match.line,
			text: match.text,
			context: rows(match.context)?.map((line) => ({
				line: line.line,
				text: line.text
			}))
		})) };
		if (Object.values(found)[0] === void 0) throw new SynsError("handler_error", { log: `exit=0 the result lacks the rows of output ${String(out.output)}` });
		return {
			...common,
			...found
		};
	}
};
//#endregion
//#region src/methods/history.ts
const MAX_PATHS = 200;
const record$1 = (value) => typeof value === "object" && value !== null ? value : {};
const history = {
	name: "syns.history",
	description: "Newest versions first: who or what made each, and the paths it changed. A page's commit has by.integration syns-bb-plugin and by.trigger thread-page. No paging past limit (default 20); total says how many.",
	effect: "read",
	params: object({
		path,
		limit: {
			type: "integer",
			minimum: 1,
			maximum: 100
		}
	}),
	result: {
		type: "object",
		properties: {
			total: { type: "integer" },
			entries: {
				type: "array",
				items: {
					type: "object",
					properties: {
						version,
						number: { type: "integer" },
						parent: {
							...version,
							type: ["string", "null"]
						},
						author: nullable("string"),
						at: { type: "string" },
						message: { type: "string" },
						paths: {
							type: "array",
							items: { type: "string" },
							maxItems: MAX_PATHS
						},
						pathsTruncated: { type: "boolean" },
						by: {
							type: "object",
							properties: {
								integration: nullable("string"),
								run: nullable("string"),
								trigger: nullable("string")
							},
							required: [
								"integration",
								"run",
								"trigger"
							]
						}
					},
					required: [
						"version",
						"number",
						"parent",
						"author",
						"at",
						"message",
						"paths",
						"pathsTruncated",
						"by"
					]
				}
			}
		},
		required: ["total", "entries"]
	},
	maxRequestBytes: K64,
	maxResponseBytes: M1,
	command: (params) => ({ args: buildArgs("history", {
		file: params.path,
		limit: params.limit ?? 20
	}) }),
	shape: (out, params) => ({
		total: out.total,
		entries: Array.isArray(out.data) ? out.data.map(record$1).map((row) => {
			const paths = Array.isArray(row.filesChanged) ? row.filesChanged : typeof params.path === "string" ? [params.path] : void 0;
			const provenance = record$1(row.provenance);
			return {
				version: row.sha,
				number: row.version,
				parent: row.parentSha ?? null,
				author: row.author ?? null,
				at: row.createdAt,
				message: row.message,
				paths: paths?.slice(0, MAX_PATHS),
				pathsTruncated: paths ? paths.length > MAX_PATHS : void 0,
				by: {
					integration: provenance.integration ?? null,
					run: provenance.run ?? null,
					trigger: provenance.trigger ?? null
				}
			};
		}) : void 0
	})
};
//#endregion
//#region src/methods/ls.ts
const PAGE = 1500;
const record = (value) => typeof value === "object" && value !== null ? value : {};
const ls = {
	name: "syns.ls",
	description: "Files and folders under path (default root), one level or recursive, at version (default head). blob changes exactly when content does. Paged: up to 1500 entries from offset; nextOffset is null on the last page. Pass the version on.",
	effect: "read",
	params: object({
		path,
		recursive: { type: "boolean" },
		version,
		offset: {
			type: "integer",
			minimum: 0
		},
		limit: {
			type: "integer",
			minimum: 1,
			maximum: PAGE
		}
	}),
	result: {
		type: "object",
		properties: {
			version,
			number: { type: "integer" },
			truncated: { type: "boolean" },
			total: { type: "integer" },
			nextOffset: nullable("integer"),
			entries: {
				type: "array",
				items: {
					type: "object",
					properties: {
						path: { type: "string" },
						type: {
							type: "string",
							enum: ["file", "dir"]
						},
						size: nullable("integer"),
						blob: nullable("string")
					},
					required: [
						"path",
						"type",
						"size",
						"blob"
					]
				}
			}
		},
		required: [
			"version",
			"number",
			"truncated",
			"total",
			"nextOffset",
			"entries"
		]
	},
	maxRequestBytes: K64,
	maxResponseBytes: M1,
	command: (params) => ({ args: buildArgs("ls", {
		recursive: params.recursive === true,
		version: params.version
	}, params.path === void 0 ? [] : [params.path]) }),
	shape: (out, params) => {
		const all = Array.isArray(out.entries) ? out.entries.map(record) : void 0;
		const offset = params.offset ?? 0;
		const end = offset + (params.limit ?? PAGE);
		return {
			version: out.commitSha,
			number: out.version,
			truncated: out.truncated,
			total: all?.length,
			nextOffset: all === void 0 ? void 0 : end < all.length ? end : null,
			entries: all?.slice(offset, end).map((entry) => ({
				path: entry.path,
				type: entry.type,
				size: entry.size ?? null,
				blob: entry.sha ?? null
			}))
		};
	}
};
//#endregion
//#region src/methods/read.ts
/**
* The lines of a window that fit one answer, from its first (D22). A text crosses as a JSON string, so a
* line is measured as it is escaped. At least one line, or response_too_large.
*/
function fit(result, room, trim) {
	if (bytes(result) <= room) return result;
	if (!trim) throw new SynsError("response_too_large");
	const lines = String(result.text).split("\n");
	let used = bytes({
		...result,
		text: ""
	});
	let kept = 0;
	for (const line of lines) {
		const cost = bytes(line) - 2 + (kept > 0 ? 2 : 0);
		if (used + cost > room) break;
		used += cost;
		kept += 1;
	}
	if (kept === 0) throw new SynsError("response_too_large", { log: "one line is larger than an answer" });
	return {
		...result,
		text: lines.slice(0, kept).join("\n"),
		limit: kept
	};
}
const read = {
	name: "syns.read",
	description: "One file, a window of lines: limit lines (default 2000) from offset (default 1), at version (default head). With fit: true a window too large for one answer is cut short, limit saying how many lines came. Line ends come as \\n.",
	effect: "read",
	params: object({
		path,
		version,
		offset: {
			type: "integer",
			minimum: 1
		},
		limit: {
			type: "integer",
			minimum: 1,
			maximum: 5e3
		},
		fit: { type: "boolean" }
	}, ["path"]),
	result: {
		type: "object",
		properties: {
			version,
			number: { type: "integer" },
			path: { type: "string" },
			text: { type: "string" },
			offset: { type: "integer" },
			limit: { type: "integer" },
			totalLines: { type: "integer" },
			size: { type: "integer" },
			blob: { type: "string" }
		},
		required: [
			"version",
			"number",
			"path",
			"text",
			"offset",
			"limit",
			"totalLines",
			"size",
			"blob"
		]
	},
	maxRequestBytes: K64,
	maxResponseBytes: M1,
	command: (params) => ({ args: buildArgs("read", {
		offset: params.offset ?? 1,
		limit: params.limit ?? 2e3,
		version: params.version
	}, [params.path]) }),
	shape: (out, params) => fit({
		version: out.commitSha,
		number: out.version,
		path: out.path,
		text: out.content,
		offset: out.offset,
		limit: out.limit,
		totalLines: out.totalLines,
		size: out.size,
		blob: out.sha
	}, 1047552, params.fit === true)
};
//#endregion
//#region src/methods/place.ts
/** OWNER/NAME of a template repository. */
const template = {
	type: "string",
	minLength: 3,
	maxLength: 201,
	pattern: "^[a-z0-9][a-z0-9._-]*/[a-z0-9][a-z0-9._-]*$"
};
/**
* `syns place TEMPLATE PATH [--version N] --json` (D43). It acts on the
* session's repository as a whole, so it runs at the session's folder even
* from a document scoped to a placed folder. It publishes one version and writes the
* files to the session's checkout. The CLI checks the head itself, so it takes
* no base. It has no provenance flags, so the page's provenance goes in
* SYNS_INTEGRATION, SYNS_RUN and SYNS_TRIGGER (D44).
*/
/** Working-copy states with no unpublished local edit, measured safe to place in (HOST_FACTS §16, D46): behind only, the place lands on the newer head and the next sync converges with no review. */
const CLEAN = /* @__PURE__ */ new Set(["converged", "remote_changes"]);
const place = {
	name: "syns.place",
	description: "Place a template (OWNER/NAME, at version or its head) as a new folder at path of this session's repository: one version, the files on disk too. Runs at the session's folder whatever the scope.",
	effect: "contributed-write",
	unguarded: true,
	atRoot: true,
	minCli: "0.3.6",
	params: object({
		template,
		path,
		version: {
			type: "integer",
			minimum: 1
		}
	}, ["template", "path"]),
	result: {
		type: "object",
		properties: {
			path: { type: "string" },
			holder: { type: "string" },
			template: {
				type: "object",
				properties: {
					repo: { type: "string" },
					version: { type: "integer" },
					sha: { type: "string" }
				},
				required: [
					"repo",
					"version",
					"sha"
				]
			},
			version,
			number: { type: "integer" },
			checks: {
				type: "array",
				items: { type: "string" }
			},
			enableChecks: nullable("string")
		},
		required: [
			"path",
			"holder",
			"template",
			"version",
			"number",
			"checks",
			"enableChecks"
		]
	},
	maxRequestBytes: K64,
	maxResponseBytes: K64,
	reasons: [
		"occupied",
		"no_such_template",
		"stale_head",
		"checkout_dirty"
	],
	async procedure(params, context) {
		const status = await context.syns(["status", "--json"]);
		if (!CLEAN.has(String(status.workingCopyState))) throw fail("checkout_dirty");
		const out = await context.syns(buildArgs("place", { version: params.version }, [params.template, params.path]), void 0, { provenanceEnv: true });
		const placed = typeof out.template === "object" && out.template !== null ? out.template : {};
		return {
			path: out.path,
			holder: out.holder,
			template: {
				repo: placed.repo,
				version: placed.version,
				sha: placed.sha
			},
			version: out.commitSha,
			number: out.version,
			checks: Array.isArray(out.checks) ? out.checks : [],
			enableChecks: typeof out.enableChecks === "string" ? out.enableChecks : null
		};
	}
};
//#endregion
//#region src/methods/readMany.ts
const readMany = {
	name: "syns.readMany",
	description: "Up to 64 whole files in one call, all at one version (default the head). Each entry is a text or an error: not_found, too_large, not_text. deferred lists paths that did not fit: ask again with them and the returned version.",
	effect: "read",
	params: object({
		paths: {
			type: "array",
			minItems: 1,
			maxItems: 64,
			items: path
		},
		version
	}, ["paths"]),
	result: {
		type: "object",
		properties: {
			version,
			files: {
				type: "array",
				items: {
					type: "object",
					description: "Either path, text, size and blob, or path and error; too_large and not_text also carry size and blob.",
					properties: {
						path: { type: "string" },
						text: { type: "string" },
						size: { type: "integer" },
						blob: nullable("string"),
						error: {
							type: "string",
							enum: [
								"not_found",
								"too_large",
								"not_text"
							]
						}
					},
					required: ["path"]
				}
			},
			deferred: {
				type: "array",
				items: { type: "string" }
			}
		},
		required: [
			"version",
			"files",
			"deferred"
		]
	},
	maxRequestBytes: K64,
	maxResponseBytes: M1,
	check(params) {
		if (new Set(params.paths).size !== params.paths.length) throw new SynsError("invalid_params", { message: "Invalid parameters for syns.readMany: paths must be distinct" });
	},
	async procedure(params, context) {
		let at = params.version;
		if (at === void 0) {
			const head = (await context.syns(buildArgs("repo")))?.commitSha;
			if (typeof head !== "string") throw new SynsError("not_found");
			at = head;
		}
		const entries = await pool(params.paths, context.limits.perCall, async (filePath) => {
			try {
				const out = await context.syns(buildArgs("cat", { version: at }, [filePath]));
				if (typeof out?.content !== "string") return {
					path: filePath,
					error: "not_text",
					size: out?.size,
					blob: out?.sha ?? null
				};
				return {
					path: filePath,
					text: out.content,
					size: out.size,
					blob: out.sha ?? null
				};
			} catch (error) {
				if (error instanceof SynsError && error.code === "not_found" && error.subject !== "version") return {
					path: filePath,
					error: "not_found"
				};
				if (error instanceof SynsError && error.code === "response_too_large") return {
					path: filePath,
					error: "too_large"
				};
				throw error;
			}
		});
		const room = readMany.maxResponseBytes - ENVELOPE - bytes({
			version: at,
			files: [],
			deferred: params.paths
		});
		const files = [];
		const deferred = [];
		let used = 0;
		for (const entry of entries) {
			const kept = bytes(entry) + 1 > room && "text" in entry ? {
				path: entry.path,
				error: "too_large",
				size: entry.size,
				blob: entry.blob
			} : entry;
			const size = bytes(kept) + 1;
			if (deferred.length > 0 || used + size > room) {
				deferred.push(entry.path);
				continue;
			}
			files.push(kept);
			used += size;
		}
		return {
			version: at,
			files,
			deferred
		};
	}
};
//#endregion
//#region src/methods/repo.ts
/** What the CLI reports in a placed folder, and may report at a root later: passed on only when present, and of its type (D34). */
const passed = (out) => ({
	...Number.isInteger(out.version) || out.version === null ? { number: out.version } : {},
	...typeof out.holder === "string" ? { holder: out.holder } : {},
	...typeof out.path === "string" ? { path: out.path } : {},
	...typeof out.sharedFolder === "boolean" ? { sharedFolder: out.sharedFolder } : {}
});
const repo = {
	name: "syns.repo",
	description: "The Syns repository of this session's folder, or the placed folder it is, and its head version. The method a page polls with watch: one cheap call.",
	effect: "read",
	params: object({}),
	result: {
		type: "object",
		properties: {
			owner: { type: "string" },
			name: { type: "string" },
			version: {
				...version,
				type: ["string", "null"],
				description: "The head. null for a repository with no commit yet."
			},
			number: {
				...nullable("integer"),
				description: "The head as a number, for display. Present where the CLI reports it: CLI 0.3.6 and later."
			},
			role: nullable("string"),
			visibility: { type: "string" },
			fileCount: { type: "integer" },
			holder: {
				type: "string",
				description: "In a placed folder: OWNER/NAME of the repository holding it. owner, name, role, visibility and fileCount are then the holder's."
			},
			path: {
				type: "string",
				description: "In a placed folder: its path in the holder. Every path a page uses is counted from it."
			},
			sharedFolder: {
				type: "boolean",
				description: "true in a folder-only collaborator's checkout of a shared folder: the record is the folder's identity, and fileCount is 0."
			}
		},
		required: [
			"owner",
			"name",
			"version",
			"role",
			"visibility",
			"fileCount"
		]
	},
	maxRequestBytes: K64,
	maxResponseBytes: K64,
	command: () => ({ args: buildArgs("repo") }),
	shape: (out) => ({
		owner: out.owner,
		name: out.name,
		version: out.commitSha ?? null,
		role: out.role ?? null,
		visibility: out.visibility,
		fileCount: out.fileCount,
		...passed(out)
	})
};
//#endregion
//#region src/methods/revert.ts
const revert = {
	name: "syns.revert",
	description: "Put one file back to its text at the earlier version to, as a new version. Today the CLI checks no base, so the head is not checked, and records no provenance: syns.history shows this commit with by all null.",
	effect: "contributed-write",
	unguarded: true,
	params: object({
		path,
		to: version,
		message
	}, ["path", "to"]),
	result: {
		type: "object",
		properties: {
			version,
			number: { type: "integer" }
		},
		required: ["version", "number"]
	},
	maxRequestBytes: K64,
	maxResponseBytes: K64,
	command: (params) => ({ args: buildArgs("revert", {
		to: params.to,
		message: params.message || void 0
	}, [params.path]) }),
	shape: (out) => ({
		version: out.commitSha,
		number: out.version
	})
};
//#endregion
//#region src/methods/rm.ts
const rm = {
	name: "syns.rm",
	description: "Remove one path as a new version, made against base. A path that is not there is success with the unchanged version and changed: 0, as the CLI answers it. Published at once, with no confirmation.",
	effect: "contributed-write",
	params: object({
		path,
		base,
		message
	}, ["path", "base"]),
	result: {
		type: "object",
		properties: {
			version,
			number: { type: "integer" },
			changed: {
				type: "integer",
				description: "How many paths the new version changed. 0: the path was not there, and version is the unchanged head."
			}
		},
		required: [
			"version",
			"number",
			"changed"
		]
	},
	maxRequestBytes: K64,
	maxResponseBytes: K64,
	command: (params, sessionId) => ({ args: buildArgs("rm", {
		parent: params.base,
		message: params.message || `Remove ${params.path} from a page`.slice(0, 500),
		...provenance(sessionId)
	}, [params.path]) }),
	shape: (out) => ({
		version: out.commitSha,
		number: out.version,
		changed: out.filesChanged
	})
};
//#endregion
//#region src/methods/enableChecks.ts
/**
* `syns enable-checks --json` in the page's placed folder (D49, D59): one
* version of the holder turning on the checks the folder recorded from its
* template. The CLI guards it against an unpublished edit itself, and reads
* the page's provenance from SYNS_* (HOST_FACTS §17), as syns.place does
* (D44). It takes no base: the CLI writes against the folder's own.
*/
const enableChecks = {
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
			enabled: {
				type: "array",
				items: { type: "string" }
			},
			version,
			number: { type: "integer" }
		},
		required: [
			"holder",
			"path",
			"enabled"
		]
	},
	maxRequestBytes: K64,
	maxResponseBytes: K64,
	notFound: NOT_FOUND,
	reasons: ["stale_head", "checkout_dirty"],
	command: () => ({
		args: buildArgs("enable-checks"),
		provenanceEnv: true
	}),
	shape: (out) => ({
		holder: out.holder,
		path: out.path,
		enabled: Array.isArray(out.enabled) ? out.enabled.filter((one) => typeof one === "string") : out.enabled,
		...typeof out.commitSha === "string" ? { version: out.commitSha } : {},
		...Number.isInteger(out.version) ? { number: out.version } : {}
	})
};
//#endregion
//#region src/methods/explore.ts
const exploreResult = {
	type: "object",
	properties: {
		total: { type: "integer" },
		limit: { type: "integer" },
		offset: { type: "integer" },
		data: {
			type: "array",
			items: {
				type: "object",
				properties: {
					owner: { type: "string" },
					name: { type: "string" },
					description: nullable("string"),
					tags: {
						type: "array",
						items: { type: "string" }
					},
					status: nullable("string"),
					visibility: { type: "string" },
					fileCount: { type: "integer" },
					forkCount: { type: "integer" },
					updatedAt: nullable("string")
				},
				required: ["owner", "name"]
			}
		}
	},
	required: ["total", "data"]
};
const explore = {
	name: "syns.explore",
	description: "Public Syns repositories matching query, every tag in tags (syns-app for app templates) and status, limit at a time from offset; total says how many.",
	effect: "read",
	minCli: "0.3.6",
	params: object({
		query: {
			type: "string",
			maxLength: 200
		},
		tags: {
			type: "array",
			items: {
				type: "string",
				maxLength: 100
			},
			maxItems: 8
		},
		status: {
			type: "string",
			enum: [
				"active",
				"draft",
				"completed",
				"abandoned"
			],
			maxLength: 9
		},
		limit: {
			type: "integer",
			minimum: 1,
			maximum: 100
		},
		offset: {
			type: "integer",
			minimum: 0
		}
	}),
	result: exploreResult,
	maxRequestBytes: K64,
	maxResponseBytes: M1,
	notFound: NOT_FOUND,
	command: (params) => ({ args: buildArgs("explore", {
		query: params.query,
		tag: params.tags,
		status: params.status,
		limit: params.limit,
		offset: params.offset
	}) })
};
//#endregion
//#region src/methods/people.ts
/**
* The scope's people (D49, D59): `syns collaborators` and its verbs, one
* command each, in the page's scope folder. The CLI decides whose
* collaborators they are and which roles it takes; inside a placed folder it
* answers holder root required, which comes back as bad_scope (HOST_FACTS §17).
* And `syns users`, to find someone. Nothing here needs more than the plugin's
* oldest CLI (0.3.3).
*/
const ROLE = {
	type: "string",
	enum: [
		"admin",
		"write",
		"read"
	],
	maxLength: 5
};
/**
* A user id, as the CLI's role and remove take it. A security guard, the one
* restriction beyond the CLI's own (D60): the CLI puts the id in a URL path
* and its HTTP client collapses `.` and `..` there, so `..` would address the
* repository's own route. No `/` or `\` either.
*/
const id = {
	type: "string",
	minLength: 1,
	maxLength: 128,
	pattern: "^(?!\\.{1,2}$)[^/\\\\]+$"
};
/** Paging inside the host's 10,000 nodes. */
const limit = {
	type: "integer",
	minimum: 1,
	maximum: 100
};
const offset = {
	type: "integer",
	minimum: 0
};
const COLLABORATOR = {
	type: "object",
	properties: group("collaborator", {
		user: {
			type: "object",
			properties: {
				id: { type: "string" },
				username: nullable("string"),
				name: nullable("string"),
				email: nullable("string"),
				image: nullable("string")
			},
			required: ["id"]
		},
		role: { type: "string" },
		createdAt: nullable("string")
	}),
	required: ["user", "role"]
};
const collaboratorsResult = {
	type: "object",
	properties: {
		total: { type: "integer" },
		limit: { type: "integer" },
		offset: { type: "integer" },
		data: {
			type: "array",
			items: COLLABORATOR
		}
	},
	required: ["total", "data"]
};
const collaborators = {
	name: "syns.collaborators",
	description: "Who has access to this scope, and each one's role: a shared placed folder's own people (CLI 0.3.14), or at a root the whole repository's. limit at a time from offset; total says how many.",
	effect: "read",
	params: object({
		limit,
		offset
	}),
	result: collaboratorsResult,
	maxRequestBytes: K64,
	maxResponseBytes: M1,
	notFound: NOT_FOUND,
	reasons: ["not_permitted"],
	command: (params) => ({ args: buildArgs("collaborators", {
		limit: params.limit,
		offset: params.offset
	}) })
};
const collaboratorAdd = {
	name: "syns.collaboratorAdd",
	description: "Give a person, by Syns username or e-mail, a role on this scope: a shared placed folder (CLI 0.3.14), or at a root the whole repository. Only from the reader's own press on a control naming the person, role and scope.",
	effect: "contributed-write",
	sharing: true,
	params: object({
		user: {
			type: "string",
			maxLength: 320
		},
		role: ROLE
	}, ["user", "role"]),
	result: {
		type: "object",
		properties: {
			added: { type: "boolean" },
			target: { type: "string" },
			role: { type: "string" }
		},
		required: [
			"added",
			"target",
			"role"
		]
	},
	maxRequestBytes: K64,
	maxResponseBytes: K64,
	notFound: NOT_FOUND,
	reasons: [
		"not_permitted",
		"no_such_user",
		"already_collaborator"
	],
	command: (params) => ({ args: buildArgs(["collaborators", "add"], { role: params.role }, [params.user]) })
};
const collaboratorRole = {
	name: "syns.collaboratorRole",
	description: "Change a collaborator's role on this scope, by the user id syns.collaborators answers. Only from the reader's own press on a control naming the person and the new role.",
	effect: "contributed-write",
	sharing: true,
	params: object({
		id,
		role: ROLE
	}, ["id", "role"]),
	result: COLLABORATOR,
	maxRequestBytes: K64,
	maxResponseBytes: K64,
	notFound: NOT_FOUND,
	reasons: ["not_permitted"],
	command: (params) => ({ args: buildArgs(["collaborators", "role"], { role: params.role }, [params.id]) })
};
const collaboratorRemove = {
	name: "syns.collaboratorRemove",
	description: "Take a collaborator off this scope, by the user id syns.collaborators answers. Only from the reader's own press on a control naming the person.",
	effect: "contributed-write",
	sharing: true,
	params: object({ id }, ["id"]),
	result: {
		type: "object",
		properties: {
			removed: { type: "boolean" },
			userId: { type: "string" }
		},
		required: ["removed", "userId"]
	},
	maxRequestBytes: K64,
	maxResponseBytes: K64,
	notFound: NOT_FOUND,
	reasons: ["not_permitted"],
	command: (params) => ({ args: buildArgs(["collaborators", "remove"], { yes: true }, [params.id]) })
};
const usersResult = {
	type: "object",
	properties: { data: {
		type: "array",
		items: {
			type: "object",
			properties: {
				id: { type: "string" },
				username: { type: "string" },
				name: nullable("string"),
				image: nullable("string")
			},
			required: ["id", "username"]
		}
	} },
	required: ["data"]
};
const users = {
	name: "syns.users",
	description: "Syns people whose handle or display name matches query, at most limit: id, username, name, image. For finding someone to share with.",
	effect: "read",
	params: object({
		query: {
			type: "string",
			maxLength: 100
		},
		limit
	}, ["query"]),
	result: usersResult,
	maxRequestBytes: K64,
	maxResponseBytes: M1,
	notFound: NOT_FOUND,
	command: (params) => ({ args: buildArgs("users", { limit: params.limit }, [params.query]) })
};
//#endregion
//#region src/methods/share.ts
/**
* Sharing, and a scope's visibility (D49, D59): each method is one CLI command,
* run in the page's scope folder, its JSON passed on. The folder commands name
* `.`, the folder the run stands in; at a repository's root the CLI refuses
* that, and `repo --visibility` is refused inside a placed folder: both come
* back as bad_scope (HOST_FACTS §17). share and unshare need CLI 0.3.11, the
* first to take `.` (HOST_FACTS §15); share --visibility came in 0.3.12.
*/
/** The repository record the CLI prints for a repository or a folder's identity, as far as a page needs it. */
const RECORD = group("record", {
	owner: { type: "string" },
	name: { type: "string" },
	visibility: { type: "string" },
	role: nullable("string"),
	sharedFolder: { type: "boolean" },
	status: { type: "string" },
	description: nullable("string"),
	heldIn: {
		type: ["object", "null"],
		properties: {
			owner: { type: "string" },
			name: { type: "string" },
			path: { type: "string" }
		}
	}
});
const FOLDER = {
	holder: { type: "string" },
	path: { type: "string" }
};
const result = (properties, required) => ({
	type: "object",
	properties,
	required
});
/** The CLI checks a name itself (bad_name); the bound only keeps it an argument. */
const name = {
	type: "string",
	maxLength: 100
};
const visibility = {
	type: "string",
	enum: ["public", "private"],
	maxLength: 7
};
const FOLDER_ARG = ["."];
const shareInfoResult = result({
	...FOLDER,
	holderRole: nullable("string"),
	shared: { type: "boolean" },
	offeredName: { type: "string" },
	...RECORD
}, [
	"holder",
	"path",
	"shared"
]);
const shareInfo = {
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
	command: () => ({ args: buildArgs("share", { show: true }, FOLDER_ARG) })
};
const shareResult = result({
	...RECORD,
	...FOLDER,
	created: { type: "boolean" }
}, [
	"owner",
	"name",
	"holder",
	"path",
	"created"
]);
const share = {
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
	reasons: [
		"bad_name",
		"name_taken",
		"not_permitted"
	],
	command: (params) => ({ args: buildArgs("share", { name: params.name }, FOLDER_ARG) })
};
const unshareResult = result({
	owner: { type: "string" },
	name: { type: "string" },
	...FOLDER,
	unshared: { type: "boolean" },
	retired: nullable("boolean")
}, [
	"owner",
	"name",
	"holder",
	"path",
	"unshared"
]);
const unshare = {
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
	command: () => ({ args: buildArgs("unshare", { yes: true }, FOLDER_ARG) })
};
const folderVisibilityResult = result({
	...RECORD,
	...FOLDER,
	created: { type: "boolean" }
}, [
	"owner",
	"name",
	"visibility",
	"holder",
	"path"
]);
const folderVisibility = {
	name: "syns.folderVisibility",
	description: "Give this placed folder a visibility of its own. public: anyone, signed in or not, can find and read it. There is no way back to inheriting. Only from the reader's own press on a control saying exactly that.",
	effect: "contributed-write",
	sharing: true,
	minCli: "0.3.12",
	params: object({
		visibility,
		name
	}, ["visibility"]),
	result: folderVisibilityResult,
	maxRequestBytes: K64,
	maxResponseBytes: K64,
	notFound: NOT_FOUND,
	reasons: [
		"bad_name",
		"name_taken",
		"not_permitted"
	],
	command: (params) => ({ args: buildArgs("share", {
		visibility: params.visibility,
		name: params.name
	}, FOLDER_ARG) })
};
const repoVisibilityResult = result(RECORD, [
	"owner",
	"name",
	"visibility"
]);
const repoVisibility = {
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
	command: (params) => ({ args: buildArgs("repo", { visibility: params.visibility }) })
};
//#endregion
//#region src/methods/whoami.ts
/** Every field the CLI's whoami reports, the e-mail address included (D14). */
const OPTIONAL = [
	"name",
	"email",
	"image",
	"bio",
	"company",
	"location",
	"pronouns",
	"timeZone",
	"createdAt",
	"updatedAt"
];
//#endregion
//#region src/methods/index.ts
/**
* THE TABLE (D17, S2.21). The declaration sent to Thread Pages, the guide's
* method section and the dispatch are all derived from it. A new method is a
* new file exporting one entry, and one line here.
*/
const METHODS = [
	repo,
	{
		name: "syns.whoami",
		description: "The Syns account logged in on this session's machine, every field the CLI reports. Any but id and username may be null.",
		effect: "read",
		params: object({}),
		result: {
			type: "object",
			properties: {
				id: { type: "string" },
				username: { type: "string" },
				emailVerified: nullable("boolean"),
				...Object.fromEntries(OPTIONAL.map((key) => [key, nullable("string")]))
			},
			required: [
				"id",
				"username",
				"emailVerified",
				...OPTIONAL
			]
		},
		maxRequestBytes: K64,
		maxResponseBytes: K64,
		reasons: ["not_logged_in"],
		command: () => ({ args: buildArgs("whoami") }),
		shape: (out) => ({
			id: out.id,
			username: out.username,
			emailVerified: out.emailVerified ?? null,
			...Object.fromEntries(OPTIONAL.map((key) => [key, out[key] ?? null]))
		})
	},
	ls,
	readMany,
	history,
	commit,
	read,
	glob,
	grep,
	diff,
	{
		name: "syns.write",
		description: "One file's whole text as a new version, made against base. create: true refuses with exists when the path is already there at base. Published at once, with no confirmation.",
		effect: "contributed-write",
		params: object({
			path,
			text: {
				type: "string",
				maxLength: M1
			},
			base,
			message,
			create: { type: "boolean" }
		}, [
			"path",
			"text",
			"base"
		]),
		result: {
			type: "object",
			properties: {
				version,
				number: { type: "integer" }
			},
			required: ["version", "number"]
		},
		maxRequestBytes: M1,
		maxResponseBytes: K64,
		reasons: ["exists"],
		async procedure(params, context) {
			if (params.create === true) {
				let there = true;
				try {
					await context.syns(buildArgs("cat", { version: params.base }, [params.path]));
				} catch (error) {
					if (!(error instanceof SynsError && error.code === "not_found" && error.subject !== "version")) throw error;
					there = false;
				}
				if (there) throw fail("exists");
			}
			const fallback = `${params.create === true ? "Create" : "Write"} ${params.path} from a page`.slice(0, 500);
			const args = buildArgs("write", {
				parent: params.base,
				message: params.message || fallback,
				...provenance(context.sessionId)
			}, [params.path]);
			const out = await context.syns(args, params.text);
			return {
				version: out?.commitSha,
				number: out?.version
			};
		}
	},
	edit,
	rm,
	revert,
	readBinary,
	writeBinary,
	place,
	shareInfo,
	share,
	unshare,
	folderVisibility,
	repoVisibility,
	collaborators,
	collaboratorAdd,
	collaboratorRole,
	collaboratorRemove,
	enableChecks,
	explore,
	users
];
const parseTriple = (text) => {
	const match = /(\d+)\.(\d+)\.(\d+)/.exec(text);
	return match ? [
		Number(match[1]),
		Number(match[2]),
		Number(match[3])
	] : null;
};
const atLeast = (have, need) => {
	for (let i = 0; i < 3; i += 1) if (have[i] !== need[i]) return have[i] > need[i];
	return true;
};
function createVersions(cli, now = Date.now) {
	const held = /* @__PURE__ */ new Map();
	return { async of(where, deadline) {
		const cached = held.get(where.hostId);
		if (cached && now() - cached.at < 6e4) return {
			text: cached.text,
			triple: cached.triple,
			spawnError: null
		};
		const ran = await cli.run(where, ["--version"], void 0, deadline);
		if (ran.spawnError !== null) return {
			text: null,
			triple: null,
			spawnError: ran.spawnError
		};
		const triple = ran.exitCode === 0 ? parseTriple(ran.stdout) : null;
		const text = triple ? triple.join(".") : null;
		held.set(where.hostId, {
			at: now(),
			text,
			triple
		});
		return {
			text,
			triple,
			spawnError: null
		};
	} };
}
/** Where the CLI runs for the session: the folder the host passed, on its machine. Null when there is none; a malformed one throws. */
function sessionWhere(workspace) {
	if (workspace === null || workspace === void 0) return null;
	const w = workspace;
	if (typeof w.path !== "string" || !w.path.startsWith("/") || w.machine !== null && typeof w.machine !== "string") throw new SynsError("handler_error", { log: "the host passed a workspace without an absolute path" });
	return {
		hostId: w.machine ?? "local",
		cwd: w.path
	};
}
/**
* threadPagesInvoke: look the method up in the table, check its parameters,
* take the session's folder from the host, run the CLI, map the outcome. It knows no method by name.
* spec S2.1, S2.2, S2.14, S2.18–S2.22
*/
function createDispatch({ table = METHODS, cli, log, held = createHeld(), versions = createVersions(cli), now = Date.now }) {
	const byName = new Map(table.map((method) => [method.name, method]));
	/** Scopes found to belong to their session's repository, each held a minute (D46): the answer is about the folder, not its contents. */
	const confirmed = /* @__PURE__ */ new Map();
	/** The repository a folder's `syns repo --json` names: a placed folder's holder, else its own OWNER/NAME. */
	const repositoryOf = (out) => {
		const doc = typeof out === "object" && out !== null ? out : {};
		if (typeof doc.holder === "string") return doc.holder.toLowerCase();
		return typeof doc.owner === "string" && typeof doc.name === "string" ? `${doc.owner}/${doc.name}`.toLowerCase() : null;
	};
	async function sameRepository(session, scoped, scope, deadline) {
		const key = `${session.hostId}\u0000${session.cwd}\u0000${scope}`;
		const at = confirmed.get(key);
		if (at !== void 0 && now() - at < 6e4) return;
		const never = async () => {
			throw fail("bad_scope");
		};
		let own;
		try {
			own = repositoryOf(await interpret(await cli.run(session, ["repo", "--json"], void 0, deadline), [], never, { folder: session.cwd }));
		} catch (error) {
			if (error instanceof SynsError && (error.reason === "no_repo" || error.reason === "no_access")) throw fail("bad_scope");
			throw error;
		}
		const theirs = repositoryOf(await interpret(await cli.run(scoped, ["repo", "--json"], void 0, deadline), [], never, { folder: session.cwd }));
		if (own === null || theirs !== own) throw fail("bad_scope");
		confirmed.set(key, now());
	}
	async function run(method, params, sessionId, scope, workspace, deadline) {
		const problem = validate(method.params, params);
		if (problem) throw new SynsError("invalid_params", { message: `Invalid parameters for ${method.name} at ${problem}` });
		method.check?.(params);
		if (sessionId === null) throw fail("no_repo");
		const session = sessionWhere(workspace);
		if (!session) throw fail("no_repo");
		const where = scope === null || method.atRoot ? session : {
			hostId: session.hostId,
			cwd: `${session.cwd.replace(/\/+$/, "")}/${scope}`,
			within: session.cwd
		};
		if (where !== session) await sameRepository(session, where, scope, deadline);
		if (method.minCli) {
			const need = parseTriple(method.minCli);
			const found = await versions.of(where, deadline);
			if (found.spawnError === "cli_not_found") throw fail("cli_missing");
			if (!found.triple || !atLeast(found.triple, need)) throw fail("cli_too_old", {
				need: method.minCli,
				have: found.text
			});
		}
		const declared = method.reasons ?? [];
		let repoCheck;
		const context = {
			sessionId,
			limits: cli.limits,
			held,
			async syns(args, stdin, options) {
				const mark = provenance(sessionId);
				const env = options?.provenanceEnv ? {
					SYNS_INTEGRATION: mark.integration,
					SYNS_RUN: mark.run,
					SYNS_TRIGGER: mark.trigger
				} : void 0;
				return interpret(await cli.run(where, args, stdin, deadline, env), declared, () => repoCheck ??= cli.run(where, ["repo", "--json"], void 0, deadline), {
					folder: session.cwd,
					...method.notFound ? { notFound: method.notFound } : {}
				});
			}
		};
		let result;
		if ("procedure" in method) result = await method.procedure(params, context);
		else {
			const command = method.command(params, sessionId);
			const output = await context.syns(command.args, command.stdin, command.provenanceEnv ? { provenanceEnv: true } : void 0);
			if (typeof output !== "object" || output === null || Array.isArray(output)) throw new SynsError("handler_error", { log: "exit=0 output is not a JSON object" });
			if (method.shape) result = method.shape(output, params);
			else {
				const dropped = [];
				result = pick(method.result, output, "$", dropped);
				if (dropped.length > 0) log.warn(`${method.name} session=${sessionId} dropped from the CLI's output: ${dropped.join(", ").slice(0, 500)}`);
			}
		}
		const hole = validate(method.result, result);
		if (hole) throw new SynsError("handler_error", { log: `exit=0 the result lacks what the specification requires at ${hole}` });
		return result;
	}
	return async (call) => {
		const method = byName.get(call.method);
		if (!method) return toAnswer(new SynsError("unknown_method"));
		const sessionId = call.caller?.sessionId ?? null;
		const rawScope = call.caller?.scope;
		if (rawScope !== void 0 && rawScope !== null && typeof rawScope !== "string") return toAnswer(fail("bad_scope"));
		const scope = typeof rawScope === "string" && rawScope !== "" ? rawScope.startsWith("/") ? rawScope : rawScope.replace(/\/+$/, "") : null;
		if (scope !== null && validate(path, scope)) return toAnswer(fail("bad_scope"));
		const params = call.params ?? {};
		let timer;
		const limit = new Promise((_, reject) => {
			timer = setTimeout(() => reject(fail("timeout")), cli.limits.callMs);
		});
		let outcome = "ok";
		try {
			const work = run(method, params, sessionId, scope, call.caller?.workspace, Date.now() + cli.limits.callMs);
			work.catch(() => void 0);
			return {
				ok: true,
				result: await Promise.race([work, limit])
			};
		} catch (caught) {
			const error = caught instanceof SynsError ? caught : new SynsError("handler_error", { log: `threw ${caught instanceof Error ? caught.message : String(caught)}`.slice(0, 500) });
			outcome = error.reason ?? error.code;
			if (error.code === "handler_error") log.warn(`${method.name} session=${sessionId ?? "none"} handler_error ${error.log ?? ""}`.trim());
			return toAnswer(error);
		} finally {
			clearTimeout(timer);
			if (method.effect === "contributed-write") log.info(`${method.name} session=${sessionId ?? "none"} paths=${pathCount(method, params)} outcome=${outcome}`);
		}
	};
}
/** Of parameters that may not have passed their schema. */
function pathCount(method, params) {
	try {
		return method.pathCount ? method.pathCount(params) : typeof params.path === "string" ? 1 : 0;
	} catch {
		return 0;
	}
}
//#endregion
//#region src/scope.ts
/**
* The host half's check of a document's scope before it starts the CLI there
* (D43, D46). The scope must resolve, symlinks followed, to a directory at or
* below the session's folder, and hold its own `.syns.yaml`, so that the
* nearest identity file is the scope itself and the CLI answers for that
* folder alone. Answers the resolved folder, where the CLI is then started,
* so a link swapped in afterwards cannot move it; null when any of this fails.
* It resolves paths and asks what they are; it reads nothing in them.
*/
async function scopeFolder(cwd, within) {
	try {
		const [folder, root] = await Promise.all([realpath(cwd), realpath(within)]);
		if (!(await stat(folder)).isDirectory()) return null;
		if (folder !== root && !folder.startsWith(root.endsWith(sep) ? root : root + sep)) return null;
		if (!(await stat(join(folder, ".syns.yaml"))).isFile()) return null;
		return folder;
	} catch {
		return null;
	}
}
const executable = async (file) => access(file, constants.X_OK).then(() => true, () => false);
/** The named executable if a setting names one; else PATH, then the usual folders under home. S2.8 */
async function findSyns(synsPath, env = process.env, home = homedir()) {
	if (synsPath) return await executable(synsPath) ? synsPath : null;
	const folders = [
		...(env.PATH ?? "").split(delimiter).filter(Boolean),
		join(home, ".cargo", "bin"),
		join(home, ".local", "bin"),
		"/usr/local/bin",
		"/opt/homebrew/bin"
	];
	for (const folder of folders) {
		const candidate = join(folder, process.platform === "win32" ? "syns.exe" : "syns");
		if (await executable(candidate)) return candidate;
	}
	return null;
}
/** One process, started directly with an argument array, never through a shell. S2.10 */
function runSyns(bin, args, cwd, stdin, timeoutMs, signal, provenance) {
	return new Promise((resolve) => {
		const out = [];
		const err = [];
		let outBytes = 0;
		let errBytes = 0;
		let timedOut = false;
		let overflowed = false;
		let settled = false;
		const finish = (exitCode, spawnError) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({
				exitCode,
				stdout: Buffer.concat(out).toString("utf8"),
				stderr: Buffer.concat(err).toString("utf8"),
				timedOut,
				spawnError,
				overflowed
			});
		};
		const child = spawn(bin, args, {
			cwd,
			stdio: [
				"pipe",
				"pipe",
				"pipe"
			],
			env: {
				...process.env,
				NO_COLOR: "1",
				...provenance ?? {}
			},
			signal
		});
		const stop = () => {
			child.kill("SIGKILL");
			child.stdout.destroy();
			child.stderr.destroy();
			finish(null, null);
		};
		const timer = setTimeout(() => {
			timedOut = true;
			stop();
		}, timeoutMs);
		child.stdout.on("data", (chunk) => {
			if (overflowed) return;
			if (outBytes + chunk.length > 41943040) {
				overflowed = true;
				stop();
				return;
			}
			outBytes += chunk.length;
			out.push(chunk);
		});
		child.stderr.on("data", (chunk) => {
			if (errBytes + chunk.length > 41943040) return;
			errBytes += chunk.length;
			err.push(chunk);
		});
		child.on("error", (error) => finish(null, String(error)));
		child.on("close", (code) => finish(code, null));
		child.stdin.on("error", () => void 0);
		child.stdin.end(stdin ?? "");
	});
}
//#endregion
//#region hosts/claude/runner.ts
const refused = (spawnError) => ({
	exitCode: null,
	stdout: "",
	stderr: "",
	timedOut: false,
	spawnError,
	overflowed: false
});
/**
* The Runner on Claude Code: the session's folder is on this machine, so the CLI runs here, in-process, with what
* bb's host half calls on its machine (scopeFolder, findSyns, runSyns). No host call, so no 8 MiB bound and no
* slices. `hostId` is ignored: there is one machine.
*/
function createLocalRunner(synsPath) {
	return { async run({ cwd, within, args, env, stdin, stdinBase64, timeoutMs }) {
		let folder = cwd;
		if (within !== void 0) {
			const resolved = await scopeFolder(cwd, within);
			if (resolved === null) return refused(SCOPE_OUTSIDE);
			folder = resolved;
		}
		const bin = await findSyns(synsPath);
		if (!bin) return refused(CLI_NOT_FOUND);
		const input = stdinBase64 === void 0 ? stdin : Buffer.from(stdinBase64, "base64");
		return runSyns(bin, args, folder, input, timeoutMs, new AbortController().signal, env);
	} };
}
//#endregion
//#region hosts/claude/process.ts
/**
* The Syns contributor on Claude Code: a process contributor (unife-pages 07 R-X5, U24). It registers the same
* declaration bb gets (R-X1) with the Unife Pages daemon over its control socket, and answers each call the daemon
* POSTs to it with the same dispatch as bb's plugin, the CLI running on this machine in the folder the call names
* (`caller.workspace`, U44).
*
*   POST   /v1/contributors            { kind: "process", namespace: "syns", declaration, endpoint } → 201
*   DELETE /v1/contributors/syns       on stop
*   the daemon POSTs { namespace, method, params, caller, requestId } to the endpoint and reads the answer
*
* The endpoint is a Unix socket in a folder only this user can open, so no browser and no other user reaches it.
* Started by the daemon from this plugin's unife-pages.json (U45), it registers with the token it was given and lives
* as long as that daemon. Started by hand, it registers again after a daemon restart, and a refusal (another
* registrant holds `syns`, or an installed plugin declares it) is logged and tried again a minute later.
*/
const NAMESPACE = "syns";
const CONTROL_SOCKET = "control.sock";
const BODY_LIMIT = 8388608;
/** What the environment says, as `serve` takes it. */
function optionsFromEnv(env, log) {
	return {
		socket: env.UNIFE_PAGES_CONTROL_SOCKET || join(env.UNIFE_PAGES_HOME || join(homedir(), ".unife-pages"), CONTROL_SOCKET),
		token: env.UNIFE_PAGES_CONTRIBUTOR_TOKEN || void 0,
		synsPath: env.SYNS_PATH?.trim() || void 0,
		agentInstructions: env.SYNS_PAGES_INSTRUCTION !== "0",
		log
	};
}
/** HTTP over the daemon's control socket. */
function controlOver(socketPath, token) {
	return (method, path, body) => new Promise((resolve, reject) => {
		const text = body === void 0 ? void 0 : JSON.stringify(body);
		const headers = {
			...text === void 0 ? {} : {
				"content-type": "application/json",
				"content-length": Buffer.byteLength(text)
			},
			...token ? { "x-unife-contributor-token": token } : {}
		};
		const req = http.request({
			socketPath,
			path,
			method,
			timeout: 5e3,
			headers
		}, (res) => {
			let out = "";
			res.setEncoding("utf8");
			res.on("data", (d) => out += d);
			res.on("end", () => resolve({
				status: res.statusCode ?? 0,
				text: out
			}));
		});
		req.on("timeout", () => req.destroy(/* @__PURE__ */ new Error("timeout")));
		req.on("error", reject);
		req.end(text);
	});
}
async function serve(options) {
	const { log } = options;
	const control = controlOver(options.socket, options.token);
	const invoke = createDispatch({
		cli: createCli(createLocalRunner(options.synsPath)),
		log
	});
	const declaration = buildDeclaration(METHODS, { agentInstructions: options.agentInstructions });
	const server = http.createServer((req, res) => {
		if (req.method !== "POST" || req.url !== "/invoke") {
			res.writeHead(404).end();
			return;
		}
		const chunks = [];
		let size = 0;
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > BODY_LIMIT) req.destroy();
			else chunks.push(chunk);
		});
		req.on("end", () => {
			let call;
			try {
				const { namespace: _namespace, ...rest } = JSON.parse(Buffer.concat(chunks).toString("utf8"));
				call = rest;
			} catch {
				res.writeHead(400).end();
				return;
			}
			invoke(call).then((answer) => {
				const text = JSON.stringify(answer);
				res.writeHead(200, {
					"content-type": "application/json",
					"content-length": Buffer.byteLength(text)
				}).end(text);
			});
		});
	});
	const folder = mkdtempSync(join(tmpdir(), "syns-pages-"));
	const socketPath = join(folder, "invoke.sock");
	await new Promise((resolve, reject) => server.once("error", reject).listen(socketPath, () => resolve()));
	const endpoint = `unix:${socketPath}:/invoke`;
	let registeredWith = null;
	let firstDaemon = null;
	let retryAt = 0;
	const tick = async () => {
		let pid;
		try {
			pid = JSON.parse((await control("GET", "/v1/daemon")).text).pid;
		} catch {
			registeredWith = null;
			return;
		}
		if (options.token) {
			firstDaemon ??= pid;
			if (pid !== firstDaemon) {
				log.info(`the daemon that started this process is gone; daemon ${pid} starts its own`);
				options.onDaemonGone?.();
				return;
			}
		}
		if (pid === registeredWith || Date.now() < retryAt) return;
		const answer = await control("POST", "/v1/contributors", {
			kind: "process",
			namespace: NAMESPACE,
			declaration,
			endpoint
		}).catch((error) => ({
			status: 0,
			text: error.message
		}));
		if (answer.status === 201) {
			registeredWith = pid;
			retryAt = 0;
			log.info(`registered ${NAMESPACE} ${declaration.version} with the Unife Pages daemon ${pid}`);
		} else {
			retryAt = Date.now() + 6e4;
			log.warn(`registration refused: ${answer.status} ${answer.text.slice(0, 200)}${answer.status === 403 ? " (an installed plugin may declare this namespace; see the daemon's log)" : ""}`);
		}
	};
	let ticking = tick();
	const timer = setInterval(() => void (ticking = ticking.then(tick)), options.everyMs ?? 5e3);
	return {
		endpoint,
		async stop(unregister = true) {
			clearInterval(timer);
			await ticking.catch(() => void 0);
			if (unregister && registeredWith !== null) await control("DELETE", `/v1/contributors/${NAMESPACE}`).catch(() => void 0);
			await new Promise((resolve) => server.close(() => resolve()));
			rmSync(folder, {
				recursive: true,
				force: true
			});
		}
	};
}
//#endregion
//#region hosts/claude/main.ts
/**
* Run by hand, or by a plugin that starts it: `node dist/claude/process.js`. Ctrl-C or SIGTERM unregisters.
* Settings are the environment: SYNS_PATH (the executable), SYNS_PAGES_INSTRUCTION=0 (declare no fragment),
* UNIFE_PAGES_HOME (the daemon's home); a daemon that starts it also sets UNIFE_PAGES_CONTROL_SOCKET and
* UNIFE_PAGES_CONTRIBUTOR_TOKEN.
*/
const say = (line) => void process.stderr.write(`syns: ${line}\n`);
const served = await serve({
	...optionsFromEnv(process.env, {
		info: say,
		warn: say
	}),
	onDaemonGone: () => void served.stop(false).finally(() => process.exit(0))
});
say(`answering at ${served.endpoint}`);
const stop = () => void served.stop().finally(() => process.exit(0));
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
//#endregion
export {};
