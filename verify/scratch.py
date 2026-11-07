#!/usr/bin/env python3
"""scratch.py — throwaway Syns repositories for verify's cells and scenarios, and a list of those left behind.

What it does: `run` and `run-scenarios` import `create` and `delete` from it; by hand it lists and deletes.
  create   (imported) one private repository named `scratch-<tag>-<UTC time>-<4 hex>` with a marker in its
           description, checked out in a fresh temporary folder (`.syns.yaml`, a README, the `--seed` folder's files,
           pushed once). An error after the create deletes it again.
  delete   deletes one repository by owner/name or by its checkout folder, from a fresh folder holding only its
           `.syns.yaml` (Syns has no delete by name; `syns delete` acts on the folder it runs in). It refuses every
           repository whose name lacks the `scratch-` prefix or whose description lacks this script's marker, so it
           never deletes a repository someone made by hand, however it is named. One already gone is done.
  list     the account's repositories named `scratch-…`, with their age, file count and whether this script made
           them, and the account's total (every page: the server lists at most a page at a time).

When it pays: every cell or scenario run that needs a repository of its own. Repositories made by hand were left
behind until the account reached the server's limit on repositories, and the next check could not create one; made
here, the repository goes when its run goes, and `list` shows what an interrupted run left.

How to run (python3, standard library; calls `syns`):
  python3 verify/scratch.py delete <owner/name | folder>
  python3 verify/scratch.py list [--json]
Exit codes: 0 done · 1 failed or refused (named) · 5 usage error.
"""
import argparse
import json
import os
import re
import secrets
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime, timezone

PREFIX = "scratch-"
MARKER = "scratch.py: throwaway repository, deleted when its run ends"
TAG = re.compile(r"^[a-z0-9][a-z0-9-]{0,29}$")
EXIT_OK, EXIT_FAIL, EXIT_USAGE = 0, 1, 5
PAGE = 100                                   # the most `syns repo list` returns per call


class Failed(Exception):
    pass


def sh(cmd, cwd=None):
    try:
        p = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True)
    except OSError as e:
        return 127, "", str(e)
    return p.returncode, p.stdout, p.stderr


def first_line(rc_out_err):
    _, out, err = rc_out_err
    text = (err or out or "").strip()
    try:
        text = json.loads(text).get("error", text)
    except (ValueError, AttributeError):
        pass
    return " ".join(str(text).split())[:240] or "no output"


def must(cmd, cwd=None):
    r = sh(cmd, cwd)
    if r[0]:
        raise Failed(f"`{' '.join(cmd[:3])}` failed: {first_line(r)}")
    return r[1]


def repos(query=None):
    """Every repository of the caller (all pages), and the total the server reports."""
    out, offset, total = [], 0, None
    while True:
        cmd = ["syns", "repo", "list", "--json", "--limit", str(PAGE), "--offset", str(offset)]
        if query:
            cmd += ["--query", query]
        page = json.loads(must(cmd))
        data = page.get("data") or []
        total = page.get("total", total)
        out += data
        offset += len(data)
        if not data or len(data) < PAGE or (total is not None and offset >= total):
            return out, (total if total is not None else len(out))


def made_here(r):
    return (r.get("name") or "").startswith(PREFIX) and (r.get("description") or "").startswith(MARKER)


def write_identity(folder, owner, name):
    with open(os.path.join(folder, ".syns.yaml"), "w") as f:
        f.write(f"owner: {owner}\nname: {name}\n")


def create(tag, seed=None):
    """Makes the repository and its checkout; returns (owner/name, folder). Deletes it again if a later step fails."""
    if not TAG.match(tag):
        raise Failed(f"tag {tag!r}: lower-case letters, digits and dashes, short")
    try:
        me = json.loads(must(["syns", "whoami", "--json"]))
    except ValueError as e:
        raise Failed(f"`syns whoami --json` answered no JSON: {e}")
    owner = me.get("username") or me.get("handle") or me.get("login")
    if not owner:
        raise Failed("`syns whoami` named no user: run `syns login`")
    name = f"{PREFIX}{tag}-{datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S')}-{secrets.token_hex(2)}"
    folder = os.path.join(tempfile.mkdtemp(prefix=PREFIX), name)
    os.makedirs(folder)
    r = sh(["syns", "repo", "create", name, "--visibility", "private", "--description", MARKER, "--json"], cwd=folder)
    if r[0]:
        why = first_line(r)
        if "403" in why or "forbidden" in why.lower() or "limit" in why.lower():
            why += (" (the account may be at the server's limit on repositories: `python3 verify/scratch.py list` "
                    "shows scratch repositories left behind; deleting other repositories is the owner's call)")
        shutil.rmtree(os.path.dirname(folder), ignore_errors=True)
        raise Failed(f"could not create {owner}/{name}: {why}")
    repo = f"{owner}/{name}"
    try:
        if seed:
            shutil.copytree(seed, folder, dirs_exist_ok=True)
        write_identity(folder, owner, name)
        with open(os.path.join(folder, "README.md"), "a") as f:
            f.write(f"\nScratch repository made by verify/scratch.py ({tag}); deleted when its run ends.\n")
        must(["syns", "push", "-m", f"Scratch for {tag}"], cwd=folder)
    except BaseException:
        remove(repo, folder)
        raise
    return repo, folder


def remove(repo, folder=None):
    """Deletes a repository from a fresh folder holding only its identity file, and its checkout's temporary folder.
    Returns None when done, else the reason in one line. Never raises. It checks nothing: `create` uses it on its
    own repository; everything else goes through `delete`, the checked delete."""
    owner, name = repo.split("/", 1)
    tmp = None
    try:
        tmp = tempfile.mkdtemp(prefix="scratch-delete-")
        write_identity(tmp, owner, name)
        r = sh(["syns", "delete", "--yes"], cwd=tmp)
        if r[0]:
            return first_line(r)
        if folder and os.path.basename(os.path.dirname(folder)).startswith(PREFIX):
            shutil.rmtree(os.path.dirname(folder), ignore_errors=True)
        return None
    except Exception as e:                       # the caller's exit matters more than this delete
        return f"{type(e).__name__}: {e}"
    finally:
        if tmp:
            shutil.rmtree(tmp, ignore_errors=True)


def delete(target, folder=None):
    """The checked delete: (exit code, words). Refuses what this script did not make. `folder`, the checkout `create`
    returned, goes with it."""
    if os.path.isdir(target):
        folder = os.path.abspath(target)
        try:
            y = dict(l.split(":", 1) for l in open(os.path.join(folder, ".syns.yaml")).read().splitlines() if ":" in l)
            target = f"{y['owner'].strip()}/{y['name'].strip()}"
        except (OSError, KeyError) as e:
            return EXIT_FAIL, f"{folder} is not the checkout of a repository ({e})"
    if not re.match(r"^[^/\s]+/[^/\s]+$", target):
        return EXIT_USAGE, f"{target} is neither owner/name nor a checkout folder"
    owner, name = target.split("/", 1)
    if not name.startswith(PREFIX):
        return EXIT_FAIL, f"refusing to delete {target}: not a scratch repository (no `{PREFIX}` prefix)"
    try:
        found = [r for r in repos(name)[0] if r.get("name") == name and r.get("owner", owner) == owner]
    except (Failed, ValueError) as e:
        return EXIT_FAIL, f"could not read the account: {e}"
    if not found:
        return EXIT_OK, f"{target} is not on the account; nothing to delete"
    if not made_here(found[0]):
        return EXIT_FAIL, (f"refusing to delete {target}: this script did not make it (its description lacks the "
                           f"marker); deleting it is its owner's decision")
    why = remove(target, folder)
    if why:
        return EXIT_FAIL, f"could not delete {target}: {why}"
    return EXIT_OK, f"deleted {target}"


def cmd_list(a):
    try:
        allr, total = repos()
    except (Failed, ValueError) as e:
        print(f"scratch: could not read the account: {e}", file=sys.stderr)
        return EXIT_FAIL
    now = datetime.now(timezone.utc)
    rows = []
    for r in allr:
        if not (r.get("name") or "").startswith(PREFIX):
            continue
        try:
            made = datetime.fromisoformat(r["createdAt"].replace("Z", "+00:00"))
            age = round((now - made).total_seconds() / 3600, 1)
        except (KeyError, ValueError):
            age = None
        rows.append({"repo": f"{r.get('owner')}/{r['name']}", "created": r.get("createdAt"), "age_hours": age,
                     "files": r.get("fileCount"), "made_by_scratch_py": made_here(r)})
    rows.sort(key=lambda x: -(x["age_hours"] or 0))
    if a.json:
        print(json.dumps({"account_total": total, "scratch": rows}, indent=1))
        return EXIT_OK
    print(f"account: {total} repositories; {len(rows)} named {PREFIX}*")
    for x in rows:
        print(f"{x['repo']}\t{x['created']}\t{x['age_hours']} h\t{x['files']} files\t"
              f"{'made by scratch.py' if x['made_by_scratch_py'] else 'made by hand: the owner decides'}")
    return EXIT_OK


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    d = sub.add_parser("delete")
    d.add_argument("target")
    li = sub.add_parser("list")
    li.add_argument("--json", action="store_true")
    try:
        a = ap.parse_args(argv)
    except SystemExit as e:
        return EXIT_USAGE if e.code else EXIT_OK
    if a.cmd == "list":
        return cmd_list(a)
    rc, words = delete(a.target)
    print(f"scratch: {words}", file=sys.stderr if rc else sys.stdout)
    return rc


if __name__ == "__main__":
    sys.exit(main())
