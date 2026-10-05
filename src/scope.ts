import { realpath, stat } from "node:fs/promises";
import { sep } from "node:path";

/**
 * Whether cwd, symlinks followed, is a folder at or below within (D43): the
 * host half's check of a document's scope before it starts the CLI there. It
 * resolves the two paths and asks whether the first is a directory; it reads
 * nothing in either. A cwd that does not exist is not inside.
 */
export async function inside(cwd: string, within: string): Promise<boolean> {
  try {
    const [folder, root] = await Promise.all([realpath(cwd), realpath(within)]);
    if (!(await stat(folder)).isDirectory()) return false;
    return folder === root || folder.startsWith(root.endsWith(sep) ? root : root + sep);
  } catch {
    return false;
  }
}
