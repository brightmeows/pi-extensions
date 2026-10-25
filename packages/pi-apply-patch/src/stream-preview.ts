/**
 * Streaming preview for apply_patch: turns the patch text that is still being
 * generated into per-file preview blocks for the tool's renderCall.
 *
 * Fidelity is mixed, by what is knowable mid-stream:
 * - Closed sections (the next `*** ` operation marker is already present) are
 *   read from disk, run through the same planUpdate/applyReplacements the
 *   executor uses, and rendered as a real diff — preview equals outcome,
 *   including pi's semantic colors and word-level highlighting.
 * - A section still being written is colored line by line as a glimpse.
 * - A section whose hunks do not match stays visible with a warning instead of
 *   blocking the rest of the patch.
 *
 * Tolerance contract: `args.input` is a streaming JSON string argument and can
 * be truncated anywhere (dangling escapes, half a line, no terminator). Every
 * parse failure here degrades to a glimpse or an empty block; nothing throws,
 * because an exception on the render path aborts the TUI repaint.
 *
 * Caching: file contents are cached by (mtimeMs:size), closed-section results by
 * section text, and the whole block list by input length. The cache lives in the
 * render state of a single tool call, so it dies with the call.
 *
 * Synchronous contract: pi's renderers are synchronous, and this module follows
 * (statSync/readFileSync). The first frame of a large file blocks once; the
 * signature cache makes every later frame IO-free.
 *
 * Read-only: paths are checked against the workspace before any read, and the
 * decoder is strictly UTF-8 like the executor's file system, so a binary file
 * simply reports as unreadable for preview purposes.
 */

import { generateDiffString } from "@earendil-works/pi-coding-agent";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { Chunk } from "./core/types.ts";
import { applyReplacements, planUpdate } from "./core/update.ts";

export interface PreviewBlock {
  readonly kind: "add" | "update" | "delete";
  readonly path: string;
  readonly moveTo?: string;
  /** ready = real diff; partial = still being written; unmatched = failed to match; noread = unreadable. */
  readonly state: "ready" | "partial" | "unmatched" | "noread";
  readonly diff?: string;
  readonly glimpse?: readonly string[];
  readonly warning?: string;
}

export interface StreamPreviewState {
  inputLen: number;
  cached?: readonly PreviewBlock[];
  sections: Map<string, PreviewBlock>;
  files: Map<string, { sig: string; content: string }>;
}

/** @internal */
export function emptyPreviewState(): StreamPreviewState {
  return { inputLen: -1, sections: new Map(), files: new Map() };
}

interface RawSection {
  kind: "add" | "update" | "delete";
  path: string;
  moveTo?: string;
  lines: string[];
  closed: boolean;
}

/**
 * Parse streaming patch text into per-file sections, tolerating a truncated
 * tail. A section closes only when the next `*** ` marker (or End Patch) shows
 * up, so the last section of a streaming payload stays open and previews as a
 * glimpse.
 *
 * @internal
 */
export function parseSections(input: string): RawSection[] {
  const sections: RawSection[] = [];
  let current: RawSection | undefined;
  const close = () => {
    if (current) current.closed = true;
  };
  let begun = false;
  for (const line of input.split("\n")) {
    const trimmedEnd = line.replace(/\r$/, "");
    if (!begun) {
      if (trimmedEnd.trim() === "*** Begin Patch") begun = true;
      continue;
    }
    if (trimmedEnd.startsWith("*** End Patch")) {
      close();
      current = undefined;
      break;
    }
    const op = matchOperation(trimmedEnd);
    if (op) {
      close();
      current = { kind: op.kind, path: op.path, lines: [], closed: false };
      sections.push(current);
      continue;
    }
    if (trimmedEnd.startsWith("*** Move to: ") && current?.kind === "update") {
      current.moveTo = trimmedEnd.slice("*** Move to: ".length);
      continue;
    }
    if (current) current.lines.push(trimmedEnd);
  }
  return sections;
}

function matchOperation(line: string): { kind: RawSection["kind"]; path: string } | undefined {
  for (const [marker, kind] of [
    ["*** Add File: ", "add"],
    ["*** Update File: ", "update"],
    ["*** Delete File: ", "delete"],
  ] as const) {
    if (line.startsWith(marker)) return { kind, path: line.slice(marker.length) };
  }
  return undefined;
}

/** Turn hunk lines into executor chunks; matches what the parser produces for full input. */
function buildChunks(lines: readonly string[]): Chunk[] {
  const chunks: Chunk[] = [];
  let anchor: string | undefined;
  let eof = false;
  let old: string[] = [];
  let added: string[] = [];
  const flush = () => {
    if (old.length === 0 && added.length === 0 && anchor === undefined && !eof) return;
    chunks.push({
      ...(anchor !== undefined ? { anchor } : {}),
      oldLines: old,
      newLines: added,
      endOfFile: eof,
    });
    anchor = undefined;
    eof = false;
    old = [];
    added = [];
  };
  for (const line of lines) {
    if (line.startsWith("@@")) {
      flush();
      const text = line.slice(2).trim();
      anchor = text.length > 0 ? text : undefined;
      continue;
    }
    if (line === "*** End of File") {
      eof = true;
      flush();
      continue;
    }
    const prefix = line.charAt(0);
    const body = line.slice(1);
    if (prefix === "+") added.push(body);
    else if (prefix === "-") old.push(body);
    else if (prefix === " " || line === "") {
      old.push(body);
      added.push(body);
    }
    // Anything else (a stray diff header, a hash line) is ignored: the preview
    // is lenient, the executor is the gate.
  }
  flush();
  return chunks;
}

function withinWorkspace(abs: string, cwd: string): boolean {
  const rel = relative(cwd, abs);
  return (
    rel === "" ||
    (rel !== ".." &&
      !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
      !isAbsolute(rel))
  );
}

const utf8Strict = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** Same decoding as the executor's file system: strict UTF-8, BOM left to matching. */
function readFileCached(abs: string, state: StreamPreviewState): string | undefined {
  try {
    const st = statSync(abs);
    const sig = `${st.mtimeMs}:${st.size}`;
    const hit = state.files.get(abs);
    if (hit && hit.sig === sig) return hit.content;
    const content = utf8Strict.decode(readFileSync(abs));
    state.files.set(abs, { sig, content });
    return content;
  } catch {
    return undefined;
  }
}

/** Normalize line endings for display only, like makeDetails does for results. */
function toDiff(before: string, after: string): string {
  const display = (text: string) => text.replace(/\r\n?/g, "\n");
  return generateDiffString(display(before), display(after)).diff;
}

function addBlock(section: RawSection): PreviewBlock {
  const body = section.lines
    .filter((line) => line.startsWith("+"))
    .map((line) => line.slice(1))
    .join("\n");
  const content = body.length > 0 ? `${body}\n` : "";
  return {
    kind: "add",
    path: section.path,
    ...(section.moveTo !== undefined ? { moveTo: section.moveTo } : {}),
    state: "ready",
    diff: toDiff("", content),
  };
}

function deleteBlock(section: RawSection): PreviewBlock {
  return {
    kind: "delete",
    path: section.path,
    ...(section.moveTo !== undefined ? { moveTo: section.moveTo } : {}),
    state: "ready",
  };
}

function updateBlock(section: RawSection, cwd: string, state: StreamPreviewState): PreviewBlock {
  const abs = resolve(cwd, section.path);
  const base = {
    kind: "update" as const,
    path: section.path,
    ...(section.moveTo !== undefined ? { moveTo: section.moveTo } : {}),
  };
  if (!withinWorkspace(abs, cwd)) {
    return { ...base, state: "noread" };
  }
  const content = readFileCached(abs, state);
  if (content === undefined) {
    return { ...base, state: "noread" };
  }
  const plan = planUpdate(content, buildChunks(section.lines));
  const unmatched = plan.outcomes.filter((outcome) => outcome.status === "unmatched").length;
  if (unmatched > 0) {
    return {
      ...base,
      state: "unmatched",
      warning: `${unmatched} hunk${unmatched === 1 ? "" : "s"} did not match the file; the preview may be off, trust the result`,
    };
  }
  const after = applyReplacements(content, plan.replacements);
  return { ...base, state: "ready", diff: toDiff(content, after) };
}

/**
 * Build preview blocks for the current input. An unchanged input length reuses
 * the last block list; closed sections are cached by their text, so only a newly
 * completed section costs a disk read and a match.
 *
 * @internal
 */
export function buildPreview(
  input: string,
  cwd: string,
  state: StreamPreviewState,
): readonly PreviewBlock[] {
  if (input.length === state.inputLen && state.cached) return state.cached;
  const blocks: PreviewBlock[] = [];
  for (const section of parseSections(input)) {
    const isPartialUpdate = !section.closed && section.kind === "update";
    if (isPartialUpdate) {
      blocks.push({
        kind: "update",
        path: section.path,
        ...(section.moveTo !== undefined ? { moveTo: section.moveTo } : {}),
        state: "partial",
        glimpse: section.lines,
      });
      continue;
    }
    const key = `${section.kind}\0${section.path}\0${section.moveTo ?? ""}\0${section.lines.join("\n")}`;
    const hit = state.sections.get(key);
    if (hit) {
      blocks.push(hit);
      continue;
    }
    const block =
      section.kind === "add"
        ? addBlock(section)
        : section.kind === "delete"
          ? deleteBlock(section)
          : updateBlock(section, cwd, state);
    state.sections.set(key, block);
    blocks.push(block);
  }
  state.inputLen = input.length;
  state.cached = blocks;
  return blocks;
}
