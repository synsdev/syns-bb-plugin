import type { Cli } from "./cli.js";
import { VERSION } from "./declaration.js";
import { sessionWhere } from "./dispatch.js";
import { PAGEHOST } from "./pagehost.js";

/** One page-script ask, as every host sends it (unife-pages 07 R5.88). */
export interface PageScriptAsk {
  caller: { sessionId: string | null; workspace: unknown };
  documentPath: string;
  /** The version of this plugin's script the host already holds, or null. */
  have: string | null;
}

export type PageScriptAnswer = null | { version: string; script?: string };

/** How long the check may take: inside the host's 2 s for every page script (07 R5.91), so a slow CLI is a page without the script, not a late answer. */
export const PAGE_SCRIPT_MS = 1_500;

/**
 * threadPagesPageScript (S2.27–S2.29): the page host, at the plugin's version, for a page of a session whose folder
 * is a Syns repository or a folder placed in one; none for any other page. One `syns repo --json` in the folder says
 * which, every time, so a folder made a repository during a turn gets the script on its next load. Never throws.
 */
export async function answerPageScript(cli: Cli, ask: PageScriptAsk | null | undefined, ms = PAGE_SCRIPT_MS): Promise<PageScriptAnswer> {
  let where;
  try {
    where = sessionWhere(ask?.caller?.workspace);
  } catch {
    return null;
  }
  if (!where) return null;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), ms)));
  try {
    const ran = await Promise.race([cli.run(where, ["repo", "--json"], undefined, Date.now() + ms, undefined, controller.signal), late]);
    if (ran?.exitCode !== 0 || !isObject(ran.stdout)) return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
  return ask!.have === VERSION ? { version: VERSION } : { version: VERSION, script: PAGEHOST };
}

function isObject(text: string): boolean {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value);
  } catch {
    return false;
  }
}
