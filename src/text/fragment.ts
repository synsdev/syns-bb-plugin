/**
 * The instruction fragment (spec 04): read by every eligible session, every
 * time, so at most 2 KiB. It names all sixteen methods, briefly, and none other (S4.4),
 * and says in words when it applies (S4.2). Declared to the host with the
 * method list, and injected nowhere else (S4.1).
 */
export const FRAGMENT = `**Syns repository.** When this session's folder is a Syns repository, your page can read and write that repository through \`syns.*\` capabilities. Check \`context.get\` for them when the page loads; if they are absent, or a call answers \`unavailable\` with reason \`no_repo\`, say so on the page and keep the rest working. Never show invented data in their place.

- **The page never names a repository.** It is the one this session's folder belongs to.
- **Pages show published state.** Files you edit in the folder reach the page after your turn ends and is pushed. Do not expect a page to show an edit you have just made.
- **Every write needs \`base\`:** the \`version\` the page last read from \`syns.repo\`. \`syns.write\` (one file; \`create: true\` for a new one), \`syns.edit\`, \`syns.rm\`, or \`syns.commit\` for several changes as one. \`syns.revert\` alone checks no base today. If the repository has moved, the write fails with \`conflict\` and reason \`stale_head\`; re-read, show the reader what changed, and let them try again. While an agent is mid-turn in this folder, writes fail with reason \`checkout_dirty\`; say the agent is working and try again when the version moves.
- **Load with \`syns.ls\` and \`syns.readMany\`,** not one call per file. Poll only \`syns.repo\` with \`watch\`, and when its \`version\` changes ask \`syns.diff\` which files to re-read. \`syns.read\` windows a large file, \`syns.readBinary\` and \`syns.writeBinary\` move a picture's bytes, \`syns.glob\` finds paths, \`syns.grep\` searches texts; \`syns.history\` says who or what made a change, \`syns.whoami\` who the reader is.

Writes happen at once, with no confirmation, and are published to everyone who shares the repository. Make clear on the page what a control will change before the reader touches it.

Parameters, results and errors of every method: \`bb thread-page guide\`, section *Capabilities from other plugins*.
`;
