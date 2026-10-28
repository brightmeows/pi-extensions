/**
 * Extract the file paths an apply_patch call wants to reach.
 *
 * The patch format is the subset this repository's apply_patch tool accepts:
 * `*** Add File:`, `*** Update File:`, `*** Delete File:`, and
 * `*** Move to:` under an Update. Body lines are ignored; a `***` line that
 * is not one of those markers is treated as an error so the gate fails closed
 * instead of silently missing paths.
 */

import type { ExtractedTarget } from "./bash-extract.ts";
import { paths } from "./paths.ts";

const ADD = "*** Add File: ";
const UPDATE = "*** Update File: ";
const DELETE = "*** Delete File: ";
const MOVE = "*** Move to: ";

export interface PatchExtraction {
  readonly targets: readonly ExtractedTarget[];
  /** Present when the patch cannot be parsed; callers should fail closed. */
  readonly error?: string;
}

type OperationKind = "add" | "update" | "delete";

function operation(line: string): { kind: OperationKind; path: string } | undefined {
  for (const [prefix, kind] of [
    [ADD, "add"],
    [UPDATE, "update"],
    [DELETE, "delete"],
  ] as const) {
    if (line.startsWith(prefix)) return { kind, path: line.slice(prefix.length) };
  }
  return undefined;
}

/** Extract every source and move destination from one Codex-format patch. */
export function extractPatchTargets(input: string, cwd: string): PatchExtraction {
  const targets: ExtractedTarget[] = [];
  const seen = new Set<string>();
  let begun = false;
  let ended = false;
  let kind: OperationKind | undefined;
  let moved = false;

  const add = (path: string, source: string): string | undefined => {
    if (!path) return `Empty path in ${source}`;
    // apply_patch treats paths literally (no `~` or `$HOME` expansion), so
    // resolve the same way; `paths.target` would check a different location.
    const target = paths.resolve(cwd, path);
    const key = paths.key(target);
    if (!seen.has(key)) {
      seen.add(key);
      targets.push({ path: target, source });
    }
    return undefined;
  };

  for (const raw of input.split(/\r?\n/)) {
    // Update sections preserve leading spaces as context-line prefixes; the
    // other sections trim the whole line, matching the apply_patch parser.
    const marker = kind === "update" ? raw.trimEnd() : raw.trim();
    if (!begun) {
      if (marker === "*** Begin Patch") begun = true;
      else if (marker)
        return { targets: [], error: `Unexpected text before *** Begin Patch: ${marker}` };
      continue;
    }
    if (marker === "*** End Patch") {
      ended = true;
      break;
    }
    if (marker === "*** End of File") continue;
    const op = operation(marker);
    if (op) {
      kind = op.kind;
      moved = false;
      const error = add(op.path, marker);
      if (error) return { targets: [], error };
      continue;
    }
    if (marker.startsWith(MOVE)) {
      if (kind !== "update" || moved) return { targets: [], error: `Unexpected ${marker}` };
      moved = true;
      const error = add(marker.slice(MOVE.length), marker);
      if (error) return { targets: [], error };
      continue;
    }
    if (marker.startsWith("*** "))
      return { targets: [], error: `Unsupported patch marker: ${marker}` };
  }

  if (!begun) return { targets: [], error: "Missing *** Begin Patch" };
  if (!ended) return { targets: [], error: "Missing *** End Patch" };
  if (targets.length === 0) return { targets: [], error: "Patch has no file operations" };
  return { targets };
}
