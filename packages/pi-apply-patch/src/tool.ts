import {
  withFileMutationQueue,
  type Theme,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { applyPatch, formatSummary, nodeFileSystem, type ApplyContext } from "./apply.ts";
import { DEFAULT_CONFIG, type PatchRenderConfig } from "./config.ts";
import { CODEX_APPLY_PATCH_GRAMMAR } from "./grammar.ts";
import {
  countPatchFiles,
  makeDetails,
  renderPatchHeader,
  renderPatchResult,
  renderPreviewBlock,
  summarize,
  type PatchDetails,
  type PatchSummary,
} from "./render.ts";
import { buildPreview, emptyPreviewState, type StreamPreviewState } from "./stream-preview.ts";

const schema = Type.Object({
  input: Type.String({
    description: "The complete patch text, from *** Begin Patch through *** End Patch.",
  }),
});

type Dependencies = Pick<ApplyContext, "fs" | "withFileQueue">;

/**
 * Reuse the row's call component across frames. The default shell supplies the
 * state background and horizontal padding; the Box only groups the header with
 * the preview so both travel as one component.
 */
function callComponent(state: Record<string, unknown>, last: unknown): Box {
  if (last instanceof Box) {
    state.callComponent = last;
    return last;
  }
  const cached = state.callComponent as Box | undefined;
  if (cached) return cached;
  const component = new Box(0, 0, (text) => text);
  state.callComponent = component;
  return component;
}

/** Preview rows for the patch text received so far. */
function previewRows(
  args: { input?: string },
  theme: Theme,
  cwd: string,
  state: Record<string, unknown>,
): string[] {
  if (typeof args.input !== "string" || args.input.length === 0) return [];
  const previewState =
    (state.previewState as StreamPreviewState | undefined) ?? emptyPreviewState();
  state.previewState = previewState;
  return buildPreview(args.input, cwd, previewState).flatMap((block) =>
    renderPreviewBlock(block, theme),
  );
}

/** @internal */
export function makeApplyPatchTool(
  dependencies: Dependencies = { fs: nodeFileSystem, withFileQueue: withFileMutationQueue },
  getConfig: () => PatchRenderConfig = () => DEFAULT_CONFIG,
): ToolDefinition<typeof schema, PatchDetails> {
  return {
    name: "apply_patch",
    label: "apply_patch",
    promptSnippet: "Edit workspace files with Codex-format patches",
    description:
      "Apply a Codex patch to files in the current workspace. Supports *** Add File:, *** Delete File:, *** Update File:, optional *** Move to:, @@ context markers, and *** End of File. Prefix added lines with +, removed lines with -, and context lines with a space. Relative and absolute paths must resolve within the workspace. Add and move operations can overwrite existing files. The entire patch is verified before writing, and failures list every unmatched hunk across every file with the closest matching locations. An I/O failure can leave partial changes. Direct tool call only — not callable from codemode scripts: it is absent from the script's `tools` object.",
    parameters: schema,
    constrainedSampling: { type: "grammar", variants: { openai_lark: CODEX_APPLY_PATCH_GRAMMAR } },
    // Model-only: the tool is built around grammar-constrained patch generation by the
    // model itself; a codemode script assembling patch text would bypass that contract.
    // Scripts edit through pi's callable file tools instead.
    exposure: "model-only",
    renderShell: "default",
    async execute(_id, { input }, signal, _onUpdate, ctx) {
      const result = await applyPatch(input, { ...dependencies, cwd: ctx.cwd, signal });
      return {
        content: [{ type: "text", text: formatSummary(result.files) }],
        details: makeDetails(result.files),
      };
    },
    renderCall(args, theme, context) {
      const component = callComponent(context.state, context.lastComponent);
      // The header Text is stable: renderResult refreshes it in place once the
      // executed counts are known. Rebuilding it here would drop those counts
      // for one frame, because renderCall runs first on every pass.
      const header = (context.state.callText as Text | undefined) ?? new Text("", 0, 0);
      context.state.callText = header;
      // Parsing the input is the only source available while the patch streams in.
      const summary: PatchSummary = context.state.patchSummary ?? {
        fileCount: typeof args.input === "string" ? countPatchFiles(args.input) : 0,
      };
      header.setText(renderPatchHeader(theme, summary));

      component.clear();
      component.addChild(header);
      // History replay supplies a final result without an execution-start event.
      // Preview only while the call is pending and has no final result.
      if (!context.executionStarted && context.isPartial) {
        const rows = previewRows(args, theme, context.cwd, context.state);
        if (rows.length > 0) {
          component.addChild(new Text("", 0, 0));
          component.addChild(new Text(rows.join("\n"), 0, 0));
        }
      } else {
        delete context.state.previewState;
      }
      return component;
    },
    renderResult(result, { expanded, isPartial }, theme, context) {
      if (isPartial) return new Text(theme.fg("muted", "Applying patch…"), 0, 0);
      const text = result.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");
      const files =
        !context.isError && Array.isArray(result.details?.files) ? result.details.files : undefined;
      if (files) {
        const summary = summarize(files);
        const previous = context.state.patchSummary as PatchSummary | undefined;
        context.state.patchSummary = summary;
        // Refresh the header in place: lastComponent here is the result, not the
        // header. Never call context.invalidate() from a renderer — it re-enters
        // updateDisplay synchronously and the row renders twice.
        if (
          previous?.fileCount !== summary.fileCount ||
          previous?.added !== summary.added ||
          previous?.removed !== summary.removed
        )
          (context.state.callText as Text | undefined)?.setText(renderPatchHeader(theme, summary));
      }
      return renderPatchResult(result.details, text, expanded, context.isError, theme, getConfig());
    },
  };
}
