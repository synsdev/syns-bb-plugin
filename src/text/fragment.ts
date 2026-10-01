/**
 * The instruction fragment (spec 04): read by every eligible session, every
 * time. The host allows 2 KiB, but bb cuts the whole Thread Pages instruction
 * at 4,096 characters, and after its standing instruction 1,505 are left
 * (HOST_FACTS §13), so the fragment stays within FRAGMENT_MAX and leads with
 * what must never be cut: a tool first (D35). It says in words when the rest
 * applies (S4.2), names only methods this version registers (S4.4), and is
 * declared to the host with the method list and injected nowhere else (S4.1).
 */
export const FRAGMENT = `**A tool first.** Given a task a Syns app could serve (a brainstorm, plan, deck, document, sheet, board, site…), look for one before writing a page of your own: skill \`syns-tools\` says how to place it and make its app this page.

**Syns repository.** When this session's folder is a Syns repository, or a folder placed in one, the page reads and writes it through \`syns.*\`. Check \`context.get\` at load; absent, or \`unavailable\` / \`no_repo\`: say so and keep the rest working. Never show invented data.

- **The page names no repository.** It sees the repository, or the placed folder, its session's folder belongs to; paths count from there.
- **Pages show pushed state:** your edits reach the page after your turn.
- **Every write needs \`base\`,** the \`version\` last read from \`syns.repo\`. \`conflict\` / \`stale_head\`: re-read, show what changed, let the reader retry. \`checkout_dirty\`: an agent is mid-turn; retry when \`version\` moves.
- **Load with \`syns.ls\` and \`syns.readMany\`;** poll only \`syns.repo\` with \`watch\`. Writes publish at once to all who share the repository: say what a control changes.

Every method: \`bb thread-page guide\`, *Capabilities from other plugins*.
`;

/** What survives bb's 4,096-character cut after Thread Pages 1.7.0's standing instruction (2,575) and the heading "## From syns" (HOST_FACTS §13), less a margin. */
export const FRAGMENT_MAX = 1450;
