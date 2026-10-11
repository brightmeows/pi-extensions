/**
 * pi-provider-stepfun
 *
 * Registers two StepFun (阶跃星辰) providers covering both billing channels,
 * each an independent complete pi-ai `Provider` (the canonical form for
 * extensions that own discovery and stored credentials), both delegating
 * streaming to pi's built-in openai-completions transport:
 *
 *  - `stepfun`       — pay-as-you-go  (api.stepfun.com/v1)
 *  - `stepfun-plan`  — Step Plan      (api.stepfun.com/step_plan/v1)
 *
 * Both channels accept the same API key; the model sets differ:
 *  - stepfun      has step-1o-turbo-vision (32K, vision, non-reasoning)
 *  - stepfun-plan has step-router-v1 (deepseek-v4-pro or step-3.7-flash)
 *  - step-5-preview and the three Step 3.x Flash models are shared
 *
 * Authentication is pi-ai's standard `envApiKeyAuth`: a stored `/login`
 * credential owns the channel; the ambient `STEP_API_KEY` /
 * `STEP_PLAN_API_KEY` env vars are consulted only when nothing is stored.
 * An unconfigured channel resolves to undefined, so model refresh silently
 * skips it instead of reporting an error.
 *
 * Each channel refreshes its own catalog (`GET <base>/models`) when the
 * persisted snapshot is stale (4-hour window, matching pi's built-in
 * remote catalog); `pi update --models` forces an immediate refresh. The
 * response shape is UNVERIFIED (no API key at hand) — the parser accepts
 * the common OpenAI-compatible dialects and prefers shipped specs for
 * every field the catalog omits; on any mismatch the refresh throws and
 * pi keeps the static lists below.
 *
 * Compat for the original models was verified against the live API
 * (see ../../../PROVIDER.md):
 *  - `system` and `developer` roles both accepted
 *  - reasoning via standard `reasoning_effort` (low/medium/high)
 *  - Chat Completions documents `max_tokens` for output limits
 *  - thinking echoed in both `reasoning` and `reasoning_content` (transport
 *    auto-dedupes via its reasoningFields list)
 *  - streaming carries usage on every chunk
 *  - tool calls use standard OpenAI shape; streamed arguments arrive whole
 *  - context overflow returns OpenAI-style `context_length_exceeded` (HTTP 400)
 *  - step-router-v1 emits an `[Advisor consultation]` planning block in `content`;
 *    its tool_calls are otherwise standard OpenAI shape
 *
 * Step 5 Preview follows the published Chat Completions contract but still
 * needs a live wire-contract check.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	envApiKeyAuth,
	type Model,
	type OpenAICompletionsCompat,
	type Provider,
	type ProviderStreamOptions,
	type RefreshModelsContext,
	type ThinkingLevelMap,
} from "@earendil-works/pi-ai";
import { stream, streamSimple } from "@earendil-works/pi-ai/compat";

type ChatModel = Model<"openai-completions">;

const REFRESH_TIMEOUT_MS = 10_000;
/** Freshness window matching pi's built-in remote catalog (4 hours). */
const REFRESH_INTERVAL_MS = 4 * 60 * 60 * 1000;

const STANDARD_BASE = "https://api.stepfun.com/v1";
const PLAN_BASE = "https://api.stepfun.com/step_plan/v1";

// ── Types ─────────────────────────────────────────────────────────────────

interface ModelMeta {
	name: string;
	contextWindow: number;
	maxTokens: number;
	reasoning: boolean;
	input: ("text" | "image")[];
	compat?: Partial<OpenAICompletionsCompat>;
	thinkingLevelMap?: ThinkingLevelMap;
}

/**
 * Default compat. StepFun follows the OpenAI Chat Completions contract closely,
 * with explicit output-limit field selection:
 *  - supportsDeveloperRole: both `system` and `developer` are accepted
 *  - supportsReasoningEffort: emit standard `reasoning_effort`
 *  - maxTokensField: StepFun documents `max_tokens`, not `max_completion_tokens`
 * No thinkingFormat is set — the default branch sends OpenAI-style
 * reasoning_effort, and the transport reads `reasoning`/`reasoning_content`
 * generically regardless of format.
 */
const DEFAULT_COMPAT: OpenAICompletionsCompat = {
	supportsDeveloperRole: true,
	supportsReasoningEffort: true,
	maxTokensField: "max_tokens",
};

// Keep pi's extra thinking levels within StepFun's documented low/medium/high set.
const THINKING_LEVELS: ThinkingLevelMap = {
	minimal: "low",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "high",
	max: "high",
};

// Shared across both channels
const SHARED_MODELS: Record<string, ModelMeta> = {
	"step-5-preview": {
		name: "Step 5 Preview",
		contextWindow: 1_000_000,
		// pi reserves maxTokens inside the context window; the API advertises
		// up to 1M output, but using that value here would leave no input room.
		maxTokens: 65_536,
		reasoning: true,
		input: ["text", "image"],
		compat: { supportsDeveloperRole: false },
	},
	"step-3.7-flash": {
		name: "Step 3.7 Flash",
		contextWindow: 262_144,
		maxTokens: 16_384,
		reasoning: true,
		input: ["text", "image"],
	},
	"step-3.5-flash": {
		name: "Step 3.5 Flash",
		contextWindow: 262_144,
		maxTokens: 16_384,
		reasoning: true,
		input: ["text"],
	},
	// Agent/Coding-optimized snapshot of step-3.5-flash (faster, lower token use).
	"step-3.5-flash-2603": {
		name: "Step 3.5 Flash 2603",
		contextWindow: 262_144,
		maxTokens: 16_384,
		reasoning: true,
		input: ["text"],
		thinkingLevelMap: { ...THINKING_LEVELS, medium: "low" },
	},
};

// Pay-as-you-go channel only
const STANDARD_ONLY: Record<string, ModelMeta> = {
	"step-1o-turbo-vision": {
		name: "Step 1o Turbo Vision",
		contextWindow: 32_768,
		maxTokens: 8_192,
		reasoning: false,
		input: ["text", "image"],
	},
};

// Step Plan channel only; the routed engines have different context limits.
const PLAN_ONLY: Record<string, ModelMeta> = {
	"step-router-v1": {
		name: "Step Router V1",
		contextWindow: 1_048_576,
		maxTokens: 16_384,
		reasoning: true,
		input: ["text"],
	},
};

// StepFun bills in CNY; like other CN providers in this repo, cost is left at 0
// and official pricing is documented in the README.
const COST_ZERO = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const;

// ── Model config builder ──────────────────────────────────────────────────

function buildModels(providerId: string, baseUrl: string, ...maps: Record<string, ModelMeta>[]): ChatModel[] {
	const merged: Record<string, ModelMeta> = Object.assign({}, ...maps);
	return Object.entries(merged).map(([id, m]) => ({
		id,
		provider: providerId,
		api: "openai-completions" as const,
		baseUrl,
		name: m.name,
		reasoning: m.reasoning,
		input: m.input,
		cost: COST_ZERO,
		contextWindow: m.contextWindow,
		maxTokens: m.maxTokens,
		compat: { ...DEFAULT_COMPAT, ...(m.compat ?? {}) },
		...(m.reasoning ? { thinkingLevelMap: m.thinkingLevelMap ?? THINKING_LEVELS } : {}),
	}));
}

// ── Remote catalog ────────────────────────────────────────────────────────

/**
 * `GET <base>/models` catalog entry. The response shape is unverified —
 * accept the common OpenAI-compatible metadata dialects and prefer shipped
 * specs for anything the catalog omits.
 */
interface RemoteModel {
	id: string;
	name?: string;
	context_length?: number | null;
	context_window?: number | null;
	max_output_length?: number | null;
	max_output?: number | null;
	input_modalities?: string[];
	output_modalities?: string[];
}

const DEFAULT_CONTEXT_WINDOW = 262_144;
const DEFAULT_MAX_TOKENS = 16_384;

/** Chat models only, when the catalog carries modality info. */
function isChatModel(model: RemoteModel): boolean {
	const output = model.output_modalities;
	if (Array.isArray(output)) return output.includes("text");
	return true; // no modality info — no id-prefix families are known here
}

function remoteToChatModel(
	model: RemoteModel,
	knownById: Map<string, ChatModel>,
	providerId: string,
	baseUrl: string,
): ChatModel {
	const known = knownById.get(model.id);
	const ctx = [model.context_length, model.context_window].find((v) => typeof v === "number");
	const out = [model.max_output_length, model.max_output].find((v) => typeof v === "number");
	return {
		id: model.id,
		provider: providerId,
		api: "openai-completions",
		baseUrl: baseUrl,
		name: model.name || known?.name || model.id,
		reasoning: known?.reasoning ?? true,
		input: (model.input_modalities ?? known?.input ?? ["text"]).filter(
			(m) => m === "text" || m === "image",
		) as ("text" | "image")[],
		cost: COST_ZERO,
		contextWindow: ctx ?? known?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
		maxTokens: out ?? known?.maxTokens ?? DEFAULT_MAX_TOKENS,
		...((known?.reasoning ?? true)
			? { thinkingLevelMap: known?.thinkingLevelMap ?? THINKING_LEVELS }
			: {}),
		compat: known?.compat ?? DEFAULT_COMPAT,
	};
}

/**
 * Whether a persisted entry is one of this channel's chat models. Entries
 * written before the complete-provider rewrite (no provider/api stamps)
 * fail this check and are dropped by the restore phase.
 */
function isOwnChatModel(raw: unknown, providerId: string): raw is ChatModel {
	if (!raw || typeof raw !== "object") return false;
	const m = raw as Record<string, unknown>;
	return (
		m.provider === providerId &&
		m.api === "openai-completions" &&
		(m.type === undefined || m.type === "chat") &&
		typeof m.id === "string" &&
		m.id !== ""
	);
}

async function fetchRemoteCatalog(
	modelsUrl: string,
	providerId: string,
	apiKeyEnv: string,
	signal: AbortSignal,
	apiKey: string | undefined,
): Promise<RemoteModel[]> {
	if (!apiKey) throw new Error(`${apiKeyEnv} is not configured for ${providerId}`);
	const controller = new AbortController();
	const onAbort = () => controller.abort();
	const timer = setTimeout(() => controller.abort(), REFRESH_TIMEOUT_MS);
	if (signal.aborted) controller.abort();
	else signal.addEventListener("abort", onAbort, { once: true });
	try {
		const response = await fetch(modelsUrl, {
			headers: { Authorization: `Bearer ${apiKey}` },
			signal: controller.signal,
		});
		if (!response.ok) {
			throw new Error(`StepFun ${modelsUrl} returned HTTP ${response.status}`);
		}
		const body = (await response.json()) as { data?: RemoteModel[] };
		if (!Array.isArray(body?.data)) {
			throw new Error(`StepFun ${modelsUrl} returned an unexpected response shape`);
		}
		return body.data;
	} finally {
		clearTimeout(timer);
		signal.removeEventListener("abort", onAbort);
	}
}

// ── Channel provider factory ──────────────────────────────────────────────

interface ChannelOptions {
	id: string;
	name: string;
	baseUrl: string;
	apiKeyEnv: string;
	baseline: ChatModel[];
}

/**
 * One provider per billing channel, each with its own registration, auth,
 * credential env var, base URL, and catalog state. The refresh contract
 * follows pi-ai's dynamic providers:
 *
 * - Restore phase (both passes): reinstall the persisted snapshot when
 *   present; a snapshot with no readable entries is dropped (`persist:
 *   null`) so this pass refetches instead of idling out the window.
 * - Network phase: skip the fetch while the snapshot is younger than
 *   `REFRESH_INTERVAL_MS` unless `force` (e.g. `pi update --models`);
 *   otherwise fetch, persist a snapshot for offline startups, and replace
 *   the live list. On failure throw — pi keeps the previous list and
 *   reports the failed provider.
 */
function makeChannelProvider(channel: ChannelOptions): Provider<"openai-completions"> {
	let dynamicModels: readonly ChatModel[] | undefined;
	const modelsUrl = `${channel.baseUrl}/models`;
	const knownById = new Map(channel.baseline.map((m) => [m.id, m]));

	const provider: Provider<"openai-completions"> = {
		id: channel.id,
		name: channel.name,
		baseUrl: channel.baseUrl,
		// Standard pi-ai auth: a stored (/login) credential wins; otherwise
		// the ambient env var; unconfigured resolves to undefined so refresh
		// skips this channel silently.
		auth: { apiKey: envApiKeyAuth(`${channel.name} API key`, [channel.apiKeyEnv]) },
		getModels: () => dynamicModels ?? channel.baseline,
		refreshModels: async (context: RefreshModelsContext) => {
			const stored = context.stored;
			const restored = (stored?.models ?? []).filter((m) => isOwnChatModel(m, channel.id));
			const usable = restored.length > 0;
			if (
				stored &&
				!(await context.publish({ update: () => {
					dynamicModels = usable ? restored : channel.baseline;
				} }))
			) {
				return;
			}
			if (stored?.models.length && !usable) {
				// Pre-rewrite snapshot shape: nothing readable — drop it so this
				// pass refetches instead of idling out the freshness window.
				if (!(await context.publish({ persist: null }))) return;
			}
			if (!context.allowNetwork || context.signal.aborted) return;
			if (
				!context.force &&
				usable &&
				typeof stored?.checkedAt === "number" &&
				Date.now() - stored.checkedAt < REFRESH_INTERVAL_MS
			) {
				return;
			}

			const apiKey = context.credential?.type === "api_key" ? context.credential.key : undefined;
			const remote = await fetchRemoteCatalog(modelsUrl, channel.id, channel.apiKeyEnv, context.signal, apiKey);
			if (context.signal.aborted) return;

			const models = remote
				.filter(isChatModel)
				.map((m) => remoteToChatModel(m, knownById, channel.id, channel.baseUrl));
			if (models.length === 0) {
				// A chat-empty catalog is almost certainly an API anomaly; rejecting
				// it lets pi keep the previous list instead of registering nothing.
				throw new Error(`StepFun ${modelsUrl} returned no chat models`);
			}

			await context.publish({
				persist: { models, checkedAt: Date.now() },
				update: () => {
					dynamicModels = models;
				},
			});
		},
		stream: (model, context, options) => stream(model, context, options as ProviderStreamOptions),
		streamSimple: (model, context, options) => streamSimple(model, context, options),
	};
	return provider;
}

// ── Entry point ───────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	// Pay-as-you-go channel
	pi.registerProvider(
		makeChannelProvider({
			id: "stepfun",
			name: "StepFun",
			baseUrl: STANDARD_BASE,
			apiKeyEnv: "STEP_API_KEY",
			baseline: buildModels("stepfun", STANDARD_BASE, SHARED_MODELS, STANDARD_ONLY),
		}),
	);

	// Step Plan subscription channel (adds step-router-v1)
	pi.registerProvider(
		makeChannelProvider({
			id: "stepfun-plan",
			name: "StepFun (Step Plan)",
			baseUrl: PLAN_BASE,
			apiKeyEnv: "STEP_PLAN_API_KEY",
			baseline: buildModels("stepfun-plan", PLAN_BASE, SHARED_MODELS, PLAN_ONLY),
		}),
	);
}
