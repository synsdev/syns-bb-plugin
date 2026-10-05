import type { Method } from "../method.js";
import { readBinary, writeBinary } from "./binary.js";
import { commit } from "./commit.js";
import { diff } from "./diff.js";
import { edit } from "./edit.js";
import { glob } from "./glob.js";
import { grep } from "./grep.js";
import { history } from "./history.js";
import { ls } from "./ls.js";
import { read } from "./read.js";
import { place } from "./place.js";
import { readMany } from "./readMany.js";
import { repo } from "./repo.js";
import { revert } from "./revert.js";
import { rm } from "./rm.js";
import { whoami } from "./whoami.js";
import { write } from "./write.js";

/**
 * THE TABLE (D17, S2.21). The declaration sent to Thread Pages, the guide's
 * method section and the dispatch are all derived from it. A new method is a
 * new file exporting one entry, and one line here.
 */
export const METHODS: readonly Method[] = [repo, whoami, ls, readMany, history, commit, read, glob, grep, diff, write, edit, rm, revert, readBinary, writeBinary, place];
