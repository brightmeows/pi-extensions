/**
 * Folded-view cropping for apply_patch result diffs.
 *
 * The expanded view renders a diff whole; the folded view keeps the shape of
 * every changed region instead: a few unchanged lines on each side and a bounded
 * number of changed lines, so a patch touching many files still reads at a
 * glance. Ctrl+O switches the tool row to the expanded view.
 *
 * Cropping is text-only and never touches line numbers: pi's diff lines carry
 * their original numbers (`+123 text`), so dropping neighbors keeps the visible
 * numbers honest. Omission lines start with a non-diff character so the renderer
 * paints them as context rather than as added/removed content.
 */

import type { PatchRenderConfig } from "./config.ts";

function isChanged(line: string): boolean {
  return line.startsWith("+") || line.startsWith("-");
}

/** Marker line for elided content. Must not start with `+`, `-`, or a space. */
function omission(hidden: number, kind: "changed" | "unchanged"): string {
  const unit = hidden === 1 ? "line" : "lines";
  return kind === "changed"
    ? `… ${hidden} more changed ${unit} (ctrl+o to expand)`
    : `… ${hidden} unchanged ${unit}`;
}

interface Segment {
  changed: boolean;
  lines: string[];
}

/** Split a diff into runs of changed and unchanged lines, preserving order. */
function segment(diff: string): Segment[] {
  const segments: Segment[] = [];
  for (const line of diff.split("\n")) {
    const changed = isChanged(line);
    const last = segments.at(-1);
    if (last && last.changed === changed) last.lines.push(line);
    else segments.push({ changed, lines: [line] });
  }
  return segments;
}

/**
 * Crop a diff for the folded view.
 *
 * Each changed region keeps its first `maxChangedLines` changed lines; each
 * unchanged run keeps at most `contextLines` lines on the side facing a changed
 * region (outer edges of the diff keep only their inner side). Whatever is
 * dropped collapses into one marker line.
 *
 * @internal
 */
export function cropDiff(diff: string, config: PatchRenderConfig): string {
  const context = Math.max(0, Math.floor(config.contextLines));
  const maxChanged = Math.max(1, Math.floor(config.maxChangedLines));
  const segments = segment(diff);
  const rows: string[] = [];

  segments.forEach((current, index) => {
    if (current.changed) {
      const kept = current.lines.slice(0, maxChanged);
      rows.push(...kept);
      const hidden = current.lines.length - kept.length;
      if (hidden > 0) rows.push(omission(hidden, "changed"));
      return;
    }

    // Context bordering the diff edges has no changed neighbor on that side, so
    // it keeps only the inner lines and gets no marker — same convention as the
    // diff itself, which starts and ends on a context window.
    const leading = index === 0 ? 0 : context;
    const trailing = index === segments.length - 1 ? 0 : context;
    if (leading + trailing === 0) return;
    if (current.lines.length <= leading + trailing) {
      rows.push(...current.lines);
      return;
    }
    if (leading === 0) {
      rows.push(...current.lines.slice(-trailing));
      return;
    }
    if (trailing === 0) {
      rows.push(...current.lines.slice(0, leading));
      return;
    }

    rows.push(...current.lines.slice(0, leading));
    rows.push(omission(current.lines.length - leading - trailing, "unchanged"));
    rows.push(...current.lines.slice(-trailing));
  });

  return rows.join("\n");
}
