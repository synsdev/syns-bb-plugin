/**
 * The instruction fragment (spec 04): read by every eligible session, every
 * time, on any host. It leads with the one line that matters most, a tool
 * first (D35, D45), says in words when the rest applies (S4.2), names only
 * methods this version registers (S4.4), and is declared to the host with the
 * method list and injected nowhere else (S4.1). The declaration is the same on
 * every host (07 R-X1), so the text names no host's command: the host's own
 * instruction names its guide command. The protocol allows 2,048 bytes.
 */
export const FRAGMENT = `**Tool first.** Asked for a piece of work the person will keep working in? Look for a template first: \`syns explore -t syns-app -q <words>\`, then follow \`syns cat TOOLS.md --repo bartsoj/syns-templates\`.

**Syns repository.** When this session's folder is a Syns repository, or a folder placed in one, the page reads and writes it through \`syns.*\`. Not in \`context.get\`, or \`unavailable\` / \`no_repo\`: say so and keep the rest working; never show invented data.

- **The page names no repository:** it sees the one, or the placed folder, its session's folder belongs to; paths count from there.
- **Pages show pushed state:** your edits reach the page after your turn is pushed.
- **Every write needs \`base\`,** the \`version\` last read from \`syns.repo\`. On \`stale_head\`, re-read and let the reader retry; on \`checkout_dirty\` an agent is mid-turn: retry when \`version\` moves.
- **Load with \`syns.ls\` and \`syns.readMany\`;** poll only \`syns.repo\` with \`watch\`. Writes and shares act at once: only from a control saying what changes, for whom.

Every method: the guide your standing instruction names. Installing or diagnosing the plugin: \`syns cat SETUP.md --repo bartsoj/syns-bb-plugin-setup\`.
`;
