import { createHash } from "node:crypto";
import { buildArgs } from "../cli.js";
import { FILE_MAX, SynsError, fail } from "../errors.js";
import type { Read, Upload } from "../held.js";
import { GATHERING_PER_SESSION } from "../held.js";
import { K64, M1, base, message, nullable, object, path, provenance, version, type Context, type ProcedureMethod, type Schema } from "../method.js";

/**
 * Pictures (D23–D27, roadmap 212, D-088). Bytes cross the bridge as base64, at
 * most PIECE bytes a call either way, so a piece and its fields fit one 1 MiB
 * call. A larger picture is read, or gathered for a write, piece by piece; the
 * plugin holds it in memory between calls (held.ts).
 */

/** 720 KiB: 983,040 characters of base64, a multiple of three bytes so no piece carries padding but the last. */
export const PIECE = 737_280;

/** Base64, whole groups of four, padding only at the end. */
export const base64: Schema = { type: "string", maxLength: (PIECE / 3) * 4, pattern: "^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$" };
export const sha256: Schema = { type: "string", pattern: "^[0-9a-f]{64}$", maxLength: 64 };

const hash = (data: Buffer): string => createHash("sha256").update(data).digest("hex");
const record = (value: unknown): Record<string, unknown> => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

/** Held keys: a picture read, one being gathered, one gathered whole and kept for syns.commit. */
export const readKey = (session: string, at: string, file: string): string => `read|${session}|${at}|${file}`;
const gatherKey = (session: string, file: string, parent: string, digest: string): string => `gather|${session}|${file}|${parent}|${digest}`;
export const keptKey = (session: string, digest: string): string => `kept|${session}|${digest}`;

// --- reading ------------------------------------------------------------------

interface ReadParams {
  path: string;
  version?: string;
  offset?: number;
}

export const readBinary: ProcedureMethod = {
  name: "syns.readBinary",
  description: "One file's bytes as base64 in pieces of up to 720 KiB, at version (default head). Follow nextOffset with the first piece's version until it is null.",
  effect: "read",
  params: object({ path, version, offset: { type: "integer", minimum: 0, maximum: FILE_MAX } }, ["path"]),
  result: {
    type: "object",
    properties: {
      version,
      number: { type: "integer" },
      path: { type: "string" },
      size: { type: "integer" },
      blob: { type: "string" },
      mediaType: nullable("string"),
      sha256,
      offset: { type: "integer" },
      base64: { type: "string" },
      nextOffset: nullable("integer"),
    },
    required: ["version", "number", "path", "size", "blob", "mediaType", "sha256", "offset", "base64", "nextOffset"],
  },
  maxRequestBytes: K64,
  maxResponseBytes: M1,
  check(params: ReadParams) {
    // A later piece is only the same picture at the version the first was read at. D24
    if ((params.offset ?? 0) > 0 && params.version === undefined) throw new SynsError("invalid_params", { message: "Invalid parameters for syns.readBinary: a later piece needs the version of the first" });
  },

  async procedure(params: ReadParams, context: Context) {
    let held = params.version === undefined ? undefined : context.held.get<Read>(readKey(context.sessionId, params.version, params.path));
    if (!held) {
      // One CLI read for the whole picture; dropped bytes are read again at the pinned version, which are the same. D24
      const out = record(await context.syns(buildArgs("cat", { version: params.version }, [params.path])));
      const data = typeof out.contentBase64 === "string" ? Buffer.from(out.contentBase64, "base64") : typeof out.content === "string" ? Buffer.from(out.content, "utf8") : null;
      if (!data || typeof out.commitSha !== "string") throw new SynsError("handler_error", { log: "exit=0 cat carries neither content nor contentBase64" });
      held = { kind: "read", bytes: data, version: out.commitSha, number: out.version, path: params.path, blob: out.sha, mediaType: typeof out.mediaType === "string" ? out.mediaType : null, sha256: hash(data) };
      context.held.put(readKey(context.sessionId, held.version, params.path), held, data.length);
    }
    const offset = params.offset ?? 0;
    if (offset > held.bytes.length) throw new SynsError("invalid_params", { message: `Invalid parameters for syns.readBinary: offset is past the file's ${held.bytes.length} bytes` });
    const end = Math.min(offset + PIECE, held.bytes.length);
    return {
      version: held.version,
      number: held.number,
      path: held.path,
      size: held.bytes.length,
      blob: held.blob,
      mediaType: held.mediaType,
      sha256: held.sha256,
      offset,
      base64: held.bytes.subarray(offset, end).toString("base64"),
      nextOffset: end < held.bytes.length ? end : null,
    };
  },
};

// --- writing ------------------------------------------------------------------

interface WriteParams {
  path: string;
  base64: string;
  base: string;
  message?: string;
  offset?: number;
  size?: number;
  sha256?: string;
  hold?: boolean;
}

/** `write --bytes` against base, the page's provenance, the bytes on standard input. */
async function publish(params: WriteParams, data: Buffer, context: Context) {
  const args = buildArgs("write", { bytes: true, parent: params.base, message: params.message || `Write ${params.path} from a page`.slice(0, 500), ...provenance(context.sessionId) }, [params.path]);
  const out = record(await context.syns(args, data));
  return { complete: true, received: data.length, version: out.commitSha, number: out.version, changed: out.filesChanged };
}

/** Keep a gathered picture for a syns.commit that names it by its sha256 (D26). */
function keep(params: WriteParams, data: Buffer, digest: string, context: Context) {
  const kept: Upload = { kind: "upload", session: context.sessionId, path: params.path, base: params.base, size: data.length, sha256: digest, chunks: [data], received: data.length, complete: true };
  context.held.put(keptKey(context.sessionId, digest), kept, data.length);
  return { complete: true, received: data.length, upload: digest };
}

export const writeBinary: ProcedureMethod = {
  name: "syns.writeBinary",
  description: "Store a file's bytes against base: whole up to 720 KiB, or in ordered pieces with offset, size and sha256, published after the last. hold: true keeps it for syns.commit.",
  effect: "contributed-write",
  params: object(
    {
      path,
      base64,
      base,
      message,
      offset: { type: "integer", minimum: 0, maximum: FILE_MAX },
      size: { type: "integer", minimum: 0, maximum: 2 * FILE_MAX },
      sha256,
      hold: { type: "boolean" },
    },
    ["path", "base64", "base"],
  ),
  result: {
    type: "object",
    properties: {
      complete: { type: "boolean", description: "false: send the piece at received. true: published (version, number, changed), or kept (upload)." },
      received: { type: "integer" },
      version,
      number: { type: "integer" },
      changed: { type: "integer" },
      upload: sha256,
    },
    required: ["complete", "received"],
  },
  maxRequestBytes: M1,
  maxResponseBytes: K64,
  reasons: ["bad_offset", "bad_hash", "too_large"],
  check(params: WriteParams) {
    const given = [params.offset, params.size, params.sha256].filter((value) => value !== undefined).length;
    if (given !== 0 && given !== 3) throw new SynsError("invalid_params", { message: "Invalid parameters for syns.writeBinary: a piece carries offset, size and sha256 together" });
    if (params.size !== undefined && params.size > FILE_MAX) throw fail("too_large", { max: FILE_MAX });
  },

  async procedure(params: WriteParams, context: Context) {
    const piece = Buffer.from(params.base64, "base64");

    // Whole, in one call.
    if (params.offset === undefined) {
      if (params.hold === true) return keep(params, piece, hash(piece), context);
      return publish(params, piece, context);
    }

    // In pieces, in order (D25).
    const size = params.size as number;
    const digest = params.sha256 as string;
    const key = gatherKey(context.sessionId, params.path, params.base, digest);
    let gathering: Upload | undefined;
    if (params.offset === 0) {
      context.held.drop(key);
      // At most two pictures gathered per session: a third drops the oldest. D27
      const others = context.held.gathering(context.sessionId);
      for (const other of others.slice(0, Math.max(0, others.length - GATHERING_PER_SESSION + 1))) context.held.drop(other);
      gathering = { kind: "upload", session: context.sessionId, path: params.path, base: params.base, size, sha256: digest, chunks: [], received: 0, complete: false };
      context.held.put(key, gathering, size);
    } else {
      gathering = context.held.get<Upload>(key);
      if (!gathering || gathering.received !== params.offset) throw fail("bad_offset", { expected: gathering?.received ?? 0 });
    }
    if (gathering.received + piece.length > size) {
      context.held.drop(key);
      throw new SynsError("invalid_params", { message: "Invalid parameters for syns.writeBinary: the pieces are longer than size" });
    }
    gathering.chunks.push(piece);
    gathering.received += piece.length;
    if (gathering.received < size) return { complete: false, received: gathering.received };

    // The last piece: check the whole, then publish it or keep it. The pieces are dropped either way.
    context.held.drop(key);
    const data = Buffer.concat(gathering.chunks);
    if (hash(data) !== digest) throw fail("bad_hash");
    if (params.hold === true) return keep(params, data, digest, context);
    return publish(params, data, context);
  },
};
