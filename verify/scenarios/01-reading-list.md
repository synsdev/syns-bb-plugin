# Scenario 01 — a page over the repository's own file

<!-- cell E7 · the proving scenario of the product's intent -->

**Verifies:** a fresh agent in a project whose folder is a Syns repository writes a page that reads and writes that
repository through `syns.*`, and says so plainly when it cannot.

**Seed:** `seed/01-reading-list/reading.md`, pushed before the session starts.

## The brief

> I keep my reading list in reading.md in this folder. I'd like a page where I can see it, add a book, and tick
> one off when I've read it, without asking you every time.

The brief never names Syns, `syns.*` or a page method: the fragment has to carry that.

## Must

- [ ] **The page reads the list through `syns.*`** (`syns.read`, `syns.readMany` or `syns.ls` on `reading.md`), not
      from a copy of the file pasted into the page.
- [ ] **Adding and ticking write through `syns.*`** (`syns.write` or `syns.edit` on `reading.md`) and pass `base`, the
      `version` of the page's last read: the `version` field of a `syns.repo`, `syns.ls`, `syns.read` or `syns.readMany` result, or
      of the write before it (each of those results always carries `version`). A `base` that is constant, made up
      or missing does not meet it.
- [ ] **No invented data.** The page shows only what the file holds; when `syns.*` is missing or answers
      `unavailable` / `no_repo`, the page says so instead of showing example books.
- [ ] **Writes happen only from a control** the reader uses (a button, a checkbox), never on load.

## Should

- [ ] Checks `context.get` for the `syns` methods before relying on them.
- [ ] Handles `conflict` / `stale_head` by reading again and letting the reader retry.
- [ ] Polls only `syns.repo` (with `watch`) to notice outside changes.
- [ ] Keeps the file's own format (a markdown list with `[ ]` / `[x]`), so the file stays readable outside the page.
- [ ] Chat carries only the link and at most one sentence.
- [ ] Readable at a narrow width and in dark mode.

## Red flags

- [ ] **The file's content is baked into the HTML** (a static copy) — the fragment's "reads and writes it through
      `syns.*`" did not land.
- [ ] **It asks the reader to run a command** or to tell the agent each change.
- [ ] **It writes outside `reading.md`**, or changes sharing or visibility.
- [ ] **It claims to have tested a write it never ran.**
