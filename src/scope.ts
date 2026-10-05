import { realpath, stat } from "node:fs/promises";
import { join, sep } from "node:path";

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
