/**
 * pi-provider-unisound
 *
 * Registers two Unisound (云知声) MaaS providers covering both billing
 * channels, each an independent complete pi-ai `Provider` (the canonical
 * form for extensions that own discovery and stored credentials), both
 * delegating streaming to pi's built-in openai-completions transport:
 *
 *  - `unisound`       — pay-as-you-go (maas-api.unisound.com/v1)
 *  - `unisound-plan`  — Token Plan subscription
 *
 * Both channels expose the SAME platform model set — they differ only in
 * billing, not in model entitlement (permissions live on the key: a
 * u2-flash-only trial key simply cannot call the other models). Token Plan
 * keys are dedicated (not interchangeable with pay-as-you-go keys) and may
 * only be used inside coding tools — not for non-coding automation.
 *
 * Authentication is pi-ai's standard `envApiKeyAuth`: a stored `/login`
 * credential owns the channel; the ambient `UNISOUND_API_KEY` /
 * `UNISOUND_PLAN_API_KEY` env vars are consulted only when nothing is
 * stored. An unconfigured channel resolves to undefined, so model refresh
 * silently skips it instead of reporting an error.
 *
 * The model catalog is refreshed from the live API (`GET /v1/models`) when
 * the persisted snapshot is stale (4-hour window, matching pi's built-in
 * remote catalog) and restored from the snapshot on offline startups; `pi
 * update --models` forces an immediate refresh. The endpoint returns the
 * platform-wide listing regardless of key permissions (verified live), so
 * the catalog is taken as-is. `context_window` / `max_output` come from the
 * catalog; modalities, thinking behavior and pricing are not exposed by the
 * endpoint and fall back to the shipped specs below per model id.
 *
 * Compat: `u2-flash` was verified against the live API (see README and
 * ../../PROVIDER.md; re-checked 2026-09-30 after the U2-Flash release).
 * The remaining models follow the same wire contract per official docs but
 * were NOT live-tested — per-model thinking behavior still differs and is
 * encoded from the documented constraints below.
 *
 * Usage quota/balance reporting is not yet implemented — Unisound MaaS does
 * not currently expose a public quota or balance API (dashboard/billing,
 * /v1/me, /v1/balance, /v1/quota all return 404; no quota headers either).
 * When one becomes available, integrate via @d3ara1n/pi-usage-block-core.
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

// ── Constants ─────────────────────────────────────────────────────────────

const BASE_URL = "https://maas-api.unisound.com/v1";
const MODELS_PATH = `${BASE_URL}/models`;
const REFRESH_TIMEOUT_MS = 10_000;
/** Freshness window matching pi's built-in remote catalog (4 hours). */
const REFRESH_INTERVAL_MS = 4 * 60 * 60 * 1000;

// ── Compat ────────────────────────────────────────────────────────────────

/**
 * Shared contract, live-verified on u2-flash:
 *  - roles: system/user/assistant/tool only (`developer` → 400)
 *  - max_tokens: documented field name (max_completion_tokens tolerated)
 *  - streaming: standard OpenAI SSE; usage on a final empty-choices chunk
 *    with stream_options.include_usage; tool deltas standard OpenAI shape
 *  - store: false / tool strict: false accepted
 *  - thinking: `thinking: { type: "enabled" | "disabled" }` (pi "deepseek"
 *    format), on by default
 */
const UNISOUND_COMPAT: OpenAICompletionsCompat = {
	supportsDeveloperRole: false,
	// The gateway enum-validates reasoning_effort platform-wide (none/minimal/
	// low/medium/high/xhigh/max), but validating ≠ honoring: u2-flash ignores
	// it (re-verified live 2026-09-30 — effort high/low/none leave reasoning
	// unchanged; the "four-level reasoning intensity" touted in the U2-Flash
	// launch announcement is not exposed through this API), and u2 is absent
	// from the docs effort table. Models that honor it (u2-med, plus glm-5.2 /
	// kimi-k3 in the Token Plan) override this per model.
	supportsReasoningEffort: false,
	maxTokensField: "max_tokens",
	thinkingFormat: "deepseek",
};

// Models without effort levels: reasoning toggles on/off, nothing between.
const THINKING_TOGGLE: ThinkingLevelMap = {
	off: "disabled",
	minimal: null,
	low: null,
	medium: null,
	high: "enabled",
};

// u2: thinking is on by default and cannot be disabled (docs) — hide "off".
const THINKING_ALWAYS_ON: ThinkingLevelMap = {
	off: null,
	minimal: null,
	low: null,
	medium: null,
	high: "enabled",
};

// glm-5.2 / DeepSeek V4 convention (zai.json / deepseek.json native entries
// agree): high/max only — low/medium are gateway aliases, hidden per repo
// convention. Thinking can be disabled via thinking.type.
const THINKING_EFFORT_HIGH_MAX: ThinkingLevelMap = {
	off: "disabled",
	minimal: null, // alias of high
	low: null, // alias of high
	medium: null, // alias of high
	high: "high",
	xhigh: null, // alias of high
	max: "max",
};

// glm-5.3 family (opencode-go reference entry): low/high/max.
const THINKING_EFFORT_LOW_HIGH_MAX: ThinkingLevelMap = {
	off: "disabled",
	minimal: null, // alias of low
	low: "low",
	medium: null, // alias of high
	high: "high",
	xhigh: null, // alias of high
	max: "max",
};

// kimi-k3 (moonshotai.json native): low/high/max, always thinking — off is
// null; medium unsupported → hidden.
const THINKING_KIMI: ThinkingLevelMap = {
	off: null,
	minimal: null,
	low: "low",
	medium: null,
	high: "high",
	xhigh: null,
	max: "max",
};

const EFFORT_COMPAT: OpenAICompletionsCompat = { ...UNISOUND_COMPAT, supportsReasoningEffort: true };

// ── Model specs ───────────────────────────────────────────────────────────
//
// One shared spec table for both channels (same platform model set,
// verified against `GET /v1/models` 2026-10-10). Third-party model-level
// truth (modalities, thinking levels) is cross-referenced from pi's
// built-in catalog entries per ../../PROVIDER.md; entries without a usable
// reference default to the u2-flash-verified toggle contract.

// pi tracks cost in USD; Unisound lists CNY per million tokens (u2-flash
// has run launch discounts and a 2026-09/10 free month, all excluded per
// repo pricing rules). Converted at ~7.1 CNY/USD for display estimates
// only — not real billing. List prices incl. cache-hit (re-checked on the
// model hub 2026-09-30): flash ¥1/0.2/2, u2 ¥1/0.02/2, u2-med ¥8/2/28
// (input/cache/output). Cache-write pricing is not published anywhere.
// Third-party model pricing on this gateway is unpublished → 0 per rules.
const PAYG_COSTS: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
	"u2-flash": { input: 0.14, output: 0.28, cacheRead: 0.03, cacheWrite: 0 },
	u2: { input: 0.14, output: 0.28, cacheRead: 0.003, cacheWrite: 0 },
	"u2-med": { input: 1.13, output: 3.94, cacheRead: 0.28, cacheWrite: 0 },
};

// Subscription billing → cost 0 per repo pricing rules.
const PLAN_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const;
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const;

interface ModelSpec {
	name: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	contextWindow: number;
	maxTokens: number;
	thinkingLevelMap?: ThinkingLevelMap;
	compat?: OpenAICompletionsCompat;
}

const MODEL_SPECS: Record<string, ModelSpec> = {
	"u2-flash": {
		// Verified live (last re-checked 2026-09-30): thinking toggles,
		// reasoning_effort is accepted but ignored, text-only.
		// /v1/models reports contextWindow/maxOutput = 524288/131072; the
		// gateway actually admits inputs up to 1,024,000 tokens, but the
		// advertised spec is declared so pi compacts conservatively.
		name: "U2 Flash",
		reasoning: true,
		input: ["text"],
		contextWindow: 524_288,
		maxTokens: 131_072,
		thinkingLevelMap: THINKING_TOGGLE,
		compat: UNISOUND_COMPAT,
	},
	u2: {
		// Docs: thinking on by default, cannot be disabled. 160K/64K per
		// /v1/models and model hub.
		name: "U2",
		reasoning: true,
		input: ["text"],
		contextWindow: 160_000,
		maxTokens: 64_000,
		thinkingLevelMap: THINKING_ALWAYS_ON,
		compat: UNISOUND_COMPAT,
	},
	"u2-med": {
		// Docs put u2-med in neither the can't-disable nor can't-enable group,
		// so thinking.type toggles like u2-flash. Per the 2026-09 docs it also
		// honors reasoning_effort: native levels none/low/medium/high, with
		// minimal→low and xhigh/max→high as gateway aliases (hidden per repo
		// convention). Not live-tested — the dev key has no u2-med permission.
		// Max output is unpublished (/v1/models returns null) — 64K is a
		// conservative placeholder. Medical imaging model: image+text input.
		name: "U2 Med",
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 262_144,
		maxTokens: 65_536,
		thinkingLevelMap: {
			off: "disabled",
			minimal: null, // alias of low
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: null, // alias of high
			max: null, // alias of high
		},
		compat: EFFORT_COMPAT,
	},
	// u2-radimed: absent from /v1/models since at least 2026-10-10 — removed
	// (catalog is authoritative). If it returns, refresh re-registers it with
	// the generic u2 defaults.
	"glm-5.2": {
		// Docs + pi built-in native entries (zai.json) agree on high/max only;
		// reasoning_effort honored per Token Plan docs.
		name: "GLM-5.2",
		reasoning: true,
		input: ["text"],
		contextWindow: 1_048_576,
		maxTokens: 131_072,
		thinkingLevelMap: THINKING_EFFORT_HIGH_MAX,
		compat: EFFORT_COMPAT,
	},
	"glm-5.3": {
		// opencode-go reference: low/high/max; catalog 1M/131072.
		name: "GLM-5.3",
		reasoning: true,
		input: ["text"],
		contextWindow: 1_048_576,
		maxTokens: 131_072,
		thinkingLevelMap: THINKING_EFFORT_LOW_HIGH_MAX,
		compat: EFFORT_COMPAT,
	},
	"glm-5.3-flash": {
		// opencode-go reference: low/high/max, image input.
		name: "GLM-5.3 Flash",
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 1_048_576,
		maxTokens: 131_072,
		thinkingLevelMap: THINKING_EFFORT_LOW_HIGH_MAX,
		compat: EFFORT_COMPAT,
	},
	"glm-5.1": {
		// No usable thinking-level reference → conservative toggle contract.
		name: "GLM-5.1",
		reasoning: true,
		input: ["text"],
		contextWindow: 202_000,
		maxTokens: 131_072,
		thinkingLevelMap: THINKING_TOGGLE,
		compat: UNISOUND_COMPAT,
	},
	"glm-5": {
		// No usable thinking-level reference → conservative toggle contract.
		name: "GLM-5",
		reasoning: true,
		input: ["text"],
		contextWindow: 202_000,
		maxTokens: 16_000,
		thinkingLevelMap: THINKING_TOGGLE,
		compat: UNISOUND_COMPAT,
	},
	"kimi-k3": {
		// moonshotai.json native: low/high/max, always thinking; image input.
		name: "Kimi K3",
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 1_048_576,
		maxTokens: 1_048_576,
		thinkingLevelMap: THINKING_KIMI,
		compat: EFFORT_COMPAT,
	},
	"kimi-k2.5": {
		// opencode reference: image input; levels unknown → toggle.
		name: "Kimi K2.5",
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 262_144,
		maxTokens: 16_000,
		thinkingLevelMap: THINKING_TOGGLE,
		compat: UNISOUND_COMPAT,
	},
	"kimi-k2.6": {
		// moonshotai-cn native: image input; levels unknown → toggle.
		name: "Kimi K2.6",
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 262_144,
		maxTokens: 16_000,
		thinkingLevelMap: THINKING_TOGGLE,
		compat: UNISOUND_COMPAT,
	},
	"deepseek-v4-flash-0731": {
		// qwen-token-plan-cn reference: high/max.
		name: "DeepSeek V4 Flash 0731",
		reasoning: true,
		input: ["text"],
		contextWindow: 1_048_576,
		maxTokens: 393_216,
		thinkingLevelMap: THINKING_EFFORT_HIGH_MAX,
		compat: EFFORT_COMPAT,
	},
	"deepseek-v4-pro": {
		// deepseek native: high/max.
		name: "DeepSeek V4 Pro",
		reasoning: true,
		input: ["text"],
		contextWindow: 1_048_576,
		maxTokens: 384_000,
		thinkingLevelMap: THINKING_EFFORT_HIGH_MAX,
		compat: EFFORT_COMPAT,
	},
	"qwen3.8-max": {
		// opencode-go reference lists low/medium/xhigh — an inconsistent level
		// set; treat levels as unknown → toggle.
		name: "Qwen3.8 Max",
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 1_048_576,
		maxTokens: 131_072,
		thinkingLevelMap: THINKING_TOGGLE,
		compat: UNISOUND_COMPAT,
	},
	"qwen3.8-flash": {
		name: "Qwen3.8 Flash",
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 1_048_576,
		maxTokens: 131_072,
		thinkingLevelMap: THINKING_TOGGLE,
		compat: UNISOUND_COMPAT,
	},
	"qwen3.7-max": {
		name: "Qwen3.7 Max",
		reasoning: true,
		input: ["text"],
		contextWindow: 1_048_576,
		maxTokens: 131_072,
		thinkingLevelMap: THINKING_TOGGLE,
		compat: UNISOUND_COMPAT,
	},
	"qwen3.7-plus": {
		name: "Qwen3.7 Plus",
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 1_048_576,
		maxTokens: 131_072,
		thinkingLevelMap: THINKING_TOGGLE,
		compat: UNISOUND_COMPAT,
	},
	"qwen3.6-plus": {
		name: "Qwen3.6 Plus",
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 1_048_576,
		maxTokens: 65_000,
		thinkingLevelMap: THINKING_TOGGLE,
		compat: UNISOUND_COMPAT,
	},
	"qwen3.6-flash": {
		name: "Qwen3.6 Flash",
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 1_048_576,
		maxTokens: 65_000,
		thinkingLevelMap: THINKING_TOGGLE,
		compat: UNISOUND_COMPAT,
	},
	"qwen3.6-35b-a3b": {
		// No built-in reference entry at all → toggle + text-only.
		name: "Qwen3.6 35B A3B",
		reasoning: true,
		input: ["text"],
		contextWindow: 262_144,
		maxTokens: 65_000,
		thinkingLevelMap: THINKING_TOGGLE,
		compat: UNISOUND_COMPAT,
	},
	"MiniMax-M2.5": {
		name: "MiniMax M2.5",
		reasoning: true,
		input: ["text"],
		contextWindow: 204_800,
		maxTokens: 131_072,
		thinkingLevelMap: THINKING_TOGGLE,
		compat: UNISOUND_COMPAT,
	},
	"MiniMax-M3": {
		name: "MiniMax M3",
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 524_288,
		maxTokens: 1_048_576,
		thinkingLevelMap: THINKING_TOGGLE,
		compat: UNISOUND_COMPAT,
	},
};

function channelCost(channel: "payg" | "plan", id: string) {
	return channel === "plan" ? PLAN_COST : (PAYG_COSTS[id] ?? ZERO_COST);
}

function buildModels(channel: "payg" | "plan"): ChatModel[] {
	return Object.entries(MODEL_SPECS).map(([id, spec]) => ({
		id,
		provider: channel === "plan" ? "unisound-plan" : "unisound",
		api: "openai-completions" as const,
		baseUrl: BASE_URL,
		name: spec.name,
		reasoning: spec.reasoning,
		input: spec.input,
		cost: channelCost(channel, id),
		contextWindow: spec.contextWindow,
		maxTokens: spec.maxTokens,
		...(spec.thinkingLevelMap ? { thinkingLevelMap: spec.thinkingLevelMap } : {}),
		...(spec.compat ? { compat: spec.compat } : {}),
	}));
}

// ── Remote catalog ────────────────────────────────────────────────────────

/** `GET /v1/models` catalog entry (OpenAI-compatible plus Unisound metadata). */
interface RemoteModel {
	id: string;
	name?: string;
	context_window?: number | null;
	max_output?: number | null;
}

/** Shipped specs by model id, used to fill gaps in live catalog entries. */
const KNOWN_SPECS = new Map(Object.entries(MODEL_SPECS));

const DEFAULT_CONTEXT_WINDOW = 262_144;
const DEFAULT_MAX_TOKENS = 65_536;

function remoteToChatModel(model: RemoteModel, channel: "payg" | "plan"): ChatModel {
	const known = KNOWN_SPECS.get(model.id);
	return {
		id: model.id,
		provider: channel === "plan" ? "unisound-plan" : "unisound",
		api: "openai-completions",
		baseUrl: BASE_URL,
		name: model.name || known?.name || model.id,
		reasoning: known?.reasoning ?? true,
		input: known?.input ?? ["text"],
		cost: channelCost(channel, model.id),
		contextWindow:
			typeof model.context_window === "number" ? model.context_window : (known?.contextWindow ?? DEFAULT_CONTEXT_WINDOW),
		maxTokens: typeof model.max_output === "number" ? model.max_output : (known?.maxTokens ?? DEFAULT_MAX_TOKENS),
		...(known?.thinkingLevelMap ? { thinkingLevelMap: known.thinkingLevelMap } : { thinkingLevelMap: THINKING_TOGGLE }),
		...(known?.compat ? { compat: known.compat } : { compat: UNISOUND_COMPAT }),
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

async function fetchRemoteCatalog(signal: AbortSignal, apiKey: string | undefined, providerId: string): Promise<RemoteModel[]> {
	if (!apiKey) throw new Error(`API key is not configured for ${providerId}`);
	const controller = new AbortController();
	const onAbort = () => controller.abort();
	const timer = setTimeout(() => controller.abort(), REFRESH_TIMEOUT_MS);
	if (signal.aborted) controller.abort();
	else signal.addEventListener("abort", onAbort, { once: true });
	try {
		const response = await fetch(MODELS_PATH, {
			headers: { Authorization: `Bearer ${apiKey}` },
			signal: controller.signal,
		});
		if (!response.ok) {
			throw new Error(`Unisound ${MODELS_PATH} returned HTTP ${response.status}`);
		}
		const body = (await response.json()) as { data?: RemoteModel[] };
		if (!Array.isArray(body?.data)) {
			throw new Error(`Unisound ${MODELS_PATH} returned an unexpected response shape`);
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
	apiKeyEnv: string;
	channel: "payg" | "plan";
}

/**
 * One provider per billing channel, each with its own registration, auth,
 * credential env var, and catalog state. The refresh contract follows
 * pi-ai's dynamic providers:
 *
 * - Restore phase (both passes): reinstall the persisted snapshot when
 *   present, re-resolving per-channel costs in case a store entry predates
 *   a channel-cost change in the shipped table (the models-store is keyed
 *   by provider id, so each registration reads only its own snapshot). A
 *   snapshot with no readable entries is dropped (`persist: null`) so this
 *   pass refetches instead of idling out the window.
 * - Network phase: skip the fetch while the snapshot is younger than
 *   `REFRESH_INTERVAL_MS` unless `force` (e.g. `pi update --models`);
 *   otherwise fetch, persist a snapshot for offline startups, and replace
 *   the live list. On failure throw — pi keeps the previous list and
 *   reports the failed provider.
 */
function makeChannelProvider(channel: ChannelOptions): Provider<"openai-completions"> {
	let dynamicModels: readonly ChatModel[] | undefined;
	const baseline = buildModels(channel.channel);

	const provider: Provider<"openai-completions"> = {
		id: channel.id,
		name: channel.name,
		baseUrl: BASE_URL,
		// Standard pi-ai auth: a stored (/login) credential wins; otherwise
		// the ambient env var; unconfigured resolves to undefined so refresh
		// skips this channel silently.
		auth: { apiKey: envApiKeyAuth(`${channel.name} API key`, [channel.apiKeyEnv]) },
		getModels: () => dynamicModels ?? baseline,
		refreshModels: async (context: RefreshModelsContext) => {
			const stored = context.stored;
			const restored = (stored?.models ?? [])
				.filter((m) => isOwnChatModel(m, channel.id))
				.map((m) => ({ ...m, cost: channelCost(channel.channel, m.id) }));
			const usable = restored.length > 0;
			if (
				stored &&
				!(await context.publish({ update: () => {
					dynamicModels = usable ? restored : baseline;
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
			const remote = await fetchRemoteCatalog(context.signal, apiKey, channel.id);
			if (context.signal.aborted) return;

			// The endpoint lists the platform catalog regardless of key
			// permissions — taken as-is (catalog is authoritative). Every entry
			// is a chat model today; a future non-chat entry would need a filter.
			const models = remote.map((m) => remoteToChatModel(m, channel.channel));
			if (models.length === 0) {
				// A chat-empty catalog is almost certainly an API anomaly; rejecting
				// it lets pi keep the previous list instead of registering nothing.
				throw new Error(`Unisound ${MODELS_PATH} returned no models`);
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
	// Pay-as-you-go channel (Metered & Packs API key)
	pi.registerProvider(
		makeChannelProvider({ id: "unisound", name: "Unisound MaaS", apiKeyEnv: "UNISOUND_API_KEY", channel: "payg" }),
	);

	// Token Plan subscription channel (dedicated API key, coding tools only)
	pi.registerProvider(
		makeChannelProvider({
			id: "unisound-plan",
			name: "Unisound MaaS (Token Plan)",
			apiKeyEnv: "UNISOUND_PLAN_API_KEY",
			channel: "plan",
		}),
	);
}
