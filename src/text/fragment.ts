/**
 * The instruction fragment (spec 04): read by every eligible session, every time, on any host. It leads with the
 * workspace line (S4.6): when it applies, in words (S4.2), and that the page the agent writes every turn opens inside
 * the repository's workspace, which the plugin's page script brings (S2.27). Then the two steps an agent takes before
 * its first page, with the sign-in a push may ask for, where apps go, and the look. It is declared to the host with
 * the method list and injected nowhere else (S4.1). The declaration is the same on every host (07 R-X1), so the text
 * names no host's command. The owner's text (IN-0058, D90), verbatim; the protocol allows 2,048 bytes.
 */
export const FRAGMENT = `**Syns workspace.** When this session's folder is empty or a Syns repository, your page (the one you write every turn) opens inside the repository's workspace. Before your first page in a session:
- No \`.page/index.html\`: \`mkdir -p .page && syns cat .page/index.html --repo bartsoj/syns-workspace-light-template > .page/index.html\`
- No \`.syns.yaml\`: \`syns push -n <a short name for this work> --visibility private\`. If it asks for \`syns login\`: run that in the background, give the person the link it prints, and push again once it says \`Login successful\`.

Make what the person will keep using an app: a folder holding an \`index.html\`; the workspace runs it with \`syns.*\` counted from that folder (the guide's *Apps in the workspace*). Your page reports and asks; the app does the work. The workspace itself is the repository's \`.page/index.html\`: change it as the person asks.

**Look.** The design and layout of your page and every app should fit its content and overall design of the workspace.
`;
