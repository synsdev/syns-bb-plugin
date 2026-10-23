import { lstat, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";

/**
 * The host half's check of a document's scope before it starts the CLI there
 * (D43, D46). The scope must resolve, symlinks followed, to a directory at or
 * below the session's folder, and hold its own `.syns.yaml`, so that the
 * nearest identity file is the scope itself and the CLI answers for that
 * folder alone. Answers the resolved folder, where the CLI is then started,
 * so a link swapped in afterwards cannot move it; null when any of this fails.
 * It resolves paths and asks what they are; it reads nothing in them.
 */
export async function scopeFolder(cwd: string, within: string): Promise<string | null> {
  try {
    const [folder, root] = await Promise.all([realpath(cwd), realpath(within)]);
    if (!(await stat(folder)).isDirectory()) return null;
    if (folder !== root && !folder.startsWith(root.endsWith(sep) ? root : root + sep)) return null;
    if (!(await stat(join(folder, ".syns.yaml"))).isFile()) return null;
    return folder;
  } catch {
    return null;
  }
}

/**
 * The host half's check of a call's `scope` parameter (S2.31, D85): `<folder>/<scope>`, symlinks followed, must be
 * `folder` or below it. No identity file is asked for, and the CLI still runs at `folder`. A part of the scope not on
 * disk yet is joined to its nearest existing parent, so a folder the checkout does not hold is judged by where it
 * would be; a link whose target is missing is refused, since it could point anywhere once that appears. It resolves
 * paths; it reads nothing in them.
 */
export async function scopeInside(folder: string, scope: string): Promise<boolean> {
  try {
    const root = await realpath(folder);
    const rest: string[] = [];
    let at = resolve(root, scope);
    for (;;) {
      try {
        at = await realpath(at);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" || dirname(at) === at) return false;
        // Missing, or a link to something missing: only the first is judged by its parent.
        if (await lstat(at).then(() => true, () => false)) return false;
        rest.unshift(basename(at));
        at = dirname(at);
      }
    }
    const full = join(at, ...rest);
    return full === root || full.startsWith(root.endsWith(sep) ? root : root + sep);
  } catch {
    return false;
  }
}
