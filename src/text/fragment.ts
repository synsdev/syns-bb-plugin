/**
 * The instruction fragment (spec 04): read by every eligible session, every time, on any host. It leads with the
 * workspace line (S4.6): when it applies, in words (S4.2), and that the page opens inside the repository's workspace
 * with nothing to add, since the plugin's page script brings it (S2.27). Then the two steps an agent takes before its
 * first page, and where apps go. It is declared to the host with the method list and injected nowhere else (S4.1).
 * The declaration is the same on every host (07 R-X1), so the text names no host's command. The owner's text
 * (IN-0056 §4), verbatim; the protocol allows 2,048 bytes.
 */
export const FRAGMENT = `**Syns workspace.** When this session's folder is empty or a Syns repository, your page opens inside the repository's workspace, beside its files and apps; nothing to add to your page. Before your first page in a session:
- No \`.page/index.html\`: \`mkdir -p .page && syns cat .page/index.html --repo bartsoj/syns-workspace-light-template > .page/index.html\`
- No \`.syns.yaml\`: \`syns push -n <a short name for this work> --visibility private\`

Make what the person will keep using an app: a folder holding an \`index.html\`; the workspace runs it with \`syns.*\` counted from that folder (the guide's *syns* section). The workspace itself is the repository's \`.page/index.html\`: change it as the person asks.
`;
