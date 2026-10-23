**Syns workspace.** When this session's folder is empty or a Syns repository, your page opens inside the repository's workspace, beside its files and apps; nothing to add to your page. Before your first page in a session:
- No `.page/index.html`: `mkdir -p .page && syns cat .page/index.html --repo bartsoj/syns-workspace-light-template > .page/index.html`
- No `.syns.yaml`: `syns push -n <a short name for this work> --visibility private`

Make what the person will keep using an app: a folder holding an `index.html`; the workspace runs it with `syns.*` counted from that folder (the guide's *syns* section). The workspace itself is the repository's `.page/index.html`: change it as the person asks.