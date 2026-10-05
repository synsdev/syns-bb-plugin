/**
 * The instruction fragment (spec 04): read by every eligible session, every
 * time. The host allows 2 KiB, but bb cuts the whole Thread Pages instruction
 * at 4,096 characters, and after its standing instruction 1,505 are left
 * (HOST_FACTS §13), so the fragment stays within FRAGMENT_MAX and leads with
 * the one line that must never be cut, a tool first (D35, D45). It says in words when the rest
 * applies (S4.2), names only methods this version registers (S4.4), and is
 * declared to the host with the method list and injected nowhere else (S4.1).
 */
export const FRAGMENT = `**Tool first.** Asked for a piece of work the person will keep working in? Look for a template first: \`syns explore -t syns-app -q <words>\`, then follow \`syns cat TOOLS.md --repo bartsoj/syns-templates\`.

**Syns repository.** When this session's folder is a Syns repository, or a folder placed in one, the page reads and writes it through \`syns.*\`. Check \`context.get\` at load; absent, or \`unavailable\` / \`no_repo\`: say so and keep the rest working. Never show invented data.

- **The page names no repository.** It sees the repository, or the placed folder, its session's folder belongs to; paths count from there.
- **Pages show pushed state:** your edits reach the page after your turn is pushed.
- **Every write needs \`base\`,** the \`version\` last read from \`syns.repo\`. On \`stale_head\`, re-read and let the reader retry; on \`checkout_dirty\` an agent is mid-turn: retry when \`version\` moves.
- **Load with \`syns.ls\` and \`syns.readMany\`;** poll only \`syns.repo\` with \`watch\`. Writes publish at once to all who share the repository: say what a control changes.

Every method: \`bb thread-page guide\`, *Capabilities from other plugins*. Installing or diagnosing the plugin: \`syns cat SETUP.md --repo bartsoj/syns-bb-plugin\`.
`;

/** What survives bb's 4,096-character cut after Thread Pages 1.7.0's standing instruction (2,575) and the heading "## From syns" (HOST_FACTS §13), less a margin. */
export const FRAGMENT_MAX = 1450;
