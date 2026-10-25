/**
 * apply_patch render configuration, read from settings files.
 *
 * Reads global (~/.pi/agent/settings.json) and project-level (.pi/settings.json)
 * settings and layers on built-in defaults. Mirrors the pattern used by other
 * extensions in this monorepo.
 *
 * Supported keys under `applyPatch`:
 *   - contextLines: unchanged lines kept on each side of a changed region in the
 *     folded view. Default 1.
 *   - maxChangedLines: changed (-/+) lines kept per changed region in the folded
 *     view; the rest collapse into one hint line. Default 10.
 *
 * The folded view is what the TUI shows by default; ctrl+o switches the tool row
 * to the uncropped diff.
 */

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";

export interface PatchRenderConfig {
  /** Unchanged lines kept on each side of a changed region in the folded view. */
  contextLines: number;
  /** Changed lines kept per changed region in the folded view (at least 1). */
  maxChangedLines: number;
}

export const DEFAULT_CONFIG: PatchRenderConfig = {
  contextLines: 1,
  maxChangedLines: 10,
};

/** Read and parse a settings.json file. Returns parsed object or {}. */
function readSettingsFile(filePath: string): any {
  try {
    if (!fs.existsSync(filePath)) return {};
    const content = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(content);
  } catch {
    return {};
  }
}

/** Accept a finite number at or above `minimum`, rounded down; else `fallback`. */
function count(raw: unknown, minimum: number, fallback: number): number {
  return typeof raw === "number" && Number.isFinite(raw) && raw >= minimum
    ? Math.floor(raw)
    : fallback;
}

/**
 * Load the applyPatch block from project or global settings over defaults.
 * A present project `applyPatch` object replaces the global object entirely;
 * missing fields then fall back to DEFAULT_CONFIG.
 *
 * @internal
 * @param cwd - Project working directory (for .pi/settings.json lookup)
 */
export function loadConfig(cwd?: string): PatchRenderConfig {
  const globalSettings = readSettingsFile(path.join(getAgentDir(), "settings.json"));
  const projectSettings = cwd ? readSettingsFile(path.join(cwd, ".pi", "settings.json")) : {};

  const raw = projectSettings?.applyPatch ?? globalSettings?.applyPatch ?? {};

  return {
    contextLines: count(raw?.contextLines, 0, DEFAULT_CONFIG.contextLines),
    maxChangedLines: count(raw?.maxChangedLines, 1, DEFAULT_CONFIG.maxChangedLines),
  };
}
