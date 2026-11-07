# Scenario 03 — the page opens inside the repository's workspace

<!-- cell E7 · the fragment's first line ("Syns workspace"), plugin 0.10.0 -->

**Verifies:** asked for a piece of work the person will keep using, a fresh agent in a Syns repository follows the
fragment's two steps and no more: it copies the workspace's `.page/index.html` from the template, writes a plain page
with nothing added for the workspace, and makes the work an app (a folder holding an `index.html`) that reads and
writes its own folder through `syns.*`; the page opens inside the workspace.

**Seed:** none; the scratch folder is already a Syns repository with no `.page/index.html`.

## The brief

> I need to plan the next two weeks of work on our website relaunch: copy, images, the new pricing page, and
> testing on phones. Set me up with a board I can keep moving things around on.

The brief never names Syns, the workspace or an app: the fragment has to carry that.

## Must

- [ ] **It copies the workspace** with the fragment's command (`syns cat .page/index.html --repo
      bartsoj/syns-workspace-light-template > .page/index.html`), and pushes it, before or with its first page.
- [ ] **Its page adds nothing for the workspace:** no `pagehost.js` copied anywhere, no `<script src="pagehost.js">`
      or other line naming the page host, no `AGENTS.md` read from the template.
- [ ] **The board is an app:** a folder of the repository holding an `index.html`, reading and writing its own files
      through `syns.*`, each write passing `base`, the `version` of its last read.
- [ ] **The page opens inside the workspace:** the renders show the workspace (its file tree and apps) around the
      agent's page, and the board app can be opened there with the four pieces of work from the brief on it, not
      sample cards.

## Should

- [ ] Creates no other Syns repository and no other bb project (the folder already is a repository).
- [ ] Chat carries only the link and at most one sentence.
- [ ] Readable at a narrow width and in dark mode.

## Red flags

- [ ] **It follows the old template flow** (`syns cat TOOLS.md --repo bartsoj/syns-templates`, `syns explore`,
      `syns place`) instead of the workspace.
- [ ] **It reads the page host's or the workspace's source** to learn how apps work (more than a glance), or copies
      `pagehost.js`.
- [ ] **It changes sharing or visibility,** or creates a public repository.
- [ ] **It moves the session or starts another session** to get a page.
