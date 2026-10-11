/**
 * pi-provider-agnes
 *
 * Registers two Agnes AI providers, each an independent complete pi-ai
 * `Provider` (the canonical form for extensions that own discovery and
 * stored credentials):
 *
 * - `agnes`      — token billing (pricing unpublished → cost 0)
 * - `agnes-plan` — subscription plan; cost = 0
 *
 * Both channels share the same base URL and model list (text + image
 * input) but keep separate registrations, credentials, and catalog state.
 *
 * Authentication is pi-ai's standard `envApiKeyAuth`: a stored `/login`
 * credential owns the channel; the ambient `AGNES_API_KEY` /
 * `AGNES_PLAN_API_KEY` env vars are consulted only when nothing is stored.
 * An unconfigured channel resolves to undefined, so model refresh silently
 * skips it instead of reporting an error.
 *
 * The model catalog is refreshed from the live API (`GET /v1/models`) when
 * the persisted snapshot is stale (4-hour window, matching pi's built-in
 * remote catalog) and restored from the snapshot on offline startups; `pi
 * update --models` forces an immediate refresh. The endpoint returns only
 * ids (no context/pricing/modality metadata — verified live 2026-10-10),
 * so every field except id falls back to the shipped specs below; models
 * new to the catalog get the family defaults. Image-generation
 * (`agnes-image-*`) and video-generation (`agnes-video-*`) models are
 * excluded by id prefix — the catalog carries no modality field.
 *
 * Usage quota/balance reporting is not yet implemented — Agnes AI does not
 * currently expose a public quota or balance API. When one becomes
 * available, integrate via pi-usage-block-core (see plans/pi-provider-agnes.md).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	envApiKeyAuth,
	type Model,
	type Provider,
	type ProviderStreamOptions,
	type RefreshModelsContext,
} from "@earendil-works/pi-ai";
import { stream, streamSimple } from "@earendil-works/pi-ai/compat";

type ChatModel = Model<"openai-completions">;

// ── Constants ─────────────────────────────────────────────────────────────

const BASE_URL = "https://apihub.agnes-ai.com/v1";
const MODELS_PATH = `${BASE_URL}/models`;
const REFRESH_TIMEOUT_MS = 10_000;
/** Freshness window matching pi's built-in remote catalog (4 hours). */
const REFRESH_INTERVAL_MS = 4 * 60 * 60 * 1000;

// ── Models ────────────────────────────────────────────────────────────────

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const;

// Agnes enables thinking via chat_template_kwargs.enable_thinking
// (Qwen-style), so reasoning models use the qwen-chat-template format.
const REASONING_COMPAT = { thinkingFormat: "qwen-chat-template" as const };

// Family defaults for models new to the catalog (specs beyond the id are
// not exposed by the endpoint): text+image input matches every verified
// Agnes chat model.
const DEFAULT_INPUT: ("text" | "image")[] = ["text", "image"];
const DEFAULT_CONTEXT_WINDOW = 262_144;
const DEFAULT_MAX_TOKENS = 65_536;

interface ModelSpec {
	name: string;
	reasoning: boolean;
	contextWindow: number;
	maxTokens: number;
}

// Verified against `GET /v1/models` 2026-10-10 (agnes-1.5-flash is no
// longer listed — removed). Specs for the 2.x models are live-verified;
// the 2.5-pro / 3.0 entries carry no endpoint metadata and await a
// real-link check.
const MODEL_SPECS: Record<string, ModelSpec> = {
	"agnes-2.5-flash": {
		name: "Agnes 2.5 Flash",
		reasoning: true,
		contextWindow: 512_000,
		maxTokens: 65_500,
	},
	"agnes-2.0-flash": {
		name: "Agnes 2.0 Flash",
		reasoning: true,
		contextWindow: 256_000,
		maxTokens: 64_000,
	},
	"agnes-2.5-pro": {
		name: "Agnes 2.5 Pro",
		reasoning: true,
		contextWindow: DEFAULT_CONTEXT_WINDOW,
		maxTokens: DEFAULT_MAX_TOKENS,
	},
	"agnes-2.5-pro-beta": {
		name: "Agnes 2.5 Pro (Beta)",
		reasoning: true,
		contextWindow: DEFAULT_CONTEXT_WINDOW,
		maxTokens: DEFAULT_MAX_TOKENS,
	},
	"agnes-2.5-pro-alpha": {
		name: "Agnes 2.5 Pro (Alpha)",
		reasoning: true,
		contextWindow: DEFAULT_CONTEXT_WINDOW,
		maxTokens: DEFAULT_MAX_TOKENS,
	},
	"agnes-3.0-flash": {
		name: "Agnes 3.0 Flash",
		reasoning: true,
		contextWindow: DEFAULT_CONTEXT_WINDOW,
		maxTokens: DEFAULT_MAX_TOKENS,
	},
	"agnes-3.0-flash-max": {
		name: "Agnes 3.0 Flash Max",
		reasoning: true,
		contextWindow: DEFAULT_CONTEXT_WINDOW,
		maxTokens: DEFAULT_MAX_TOKENS,
	},
};

function buildBaseline(providerId: string): ChatModel[] {
	return Object.entries(MODEL_SPECS).map(([id, spec]) => ({
		id,
		provider: providerId,
		api: "openai-completions" as const,
		baseUrl: BASE_URL,
		name: spec.name,
		reasoning: spec.reasoning,
		input: [...DEFAULT_INPUT],
		cost: { ...ZERO_COST },
		contextWindow: spec.contextWindow,
		maxTokens: spec.maxTokens,
		...(spec.reasoning ? { compat: REASONING_COMPAT } : {}),
	}));
}

/** Shipped specs by model id, used to fill gaps in live catalog entries. */
const KNOWN_SPECS = new Map(Object.entries(MODEL_SPECS));

// ── Remote catalog ────────────────────────────────────────────────────────

/** `GET /v1/models` catalog entry — ids only, no metadata fields. */
interface RemoteModel {
	id: string;
}

/** Chat models only: the catalog mixes in image/video generation models. */
function isChatModel(model: RemoteModel): boolean {
	// The endpoint carries no modality field (verified live); the generation
	// families are cleanly prefixed.
	return !/^agnes-(image|video)-/.test(model.id);
}

function remoteToChatModel(model: RemoteModel, providerId: string): ChatModel {
	const known = KNOWN_SPECS.get(model.id);
	return {
		id: model.id,
		provider: providerId,
		api: "openai-completions",
		baseUrl: BASE_URL,
		name: known?.name ?? model.id,
		reasoning: known?.reasoning ?? true,
		input: [...DEFAULT_INPUT],
		cost: { ...ZERO_COST },
		contextWindow: known?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
		maxTokens: known?.maxTokens ?? DEFAULT_MAX_TOKENS,
		...(known?.reasoning ?? true ? { compat: REASONING_COMPAT } : {}),
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
			throw new Error(`Agnes ${MODELS_PATH} returned HTTP ${response.status}`);
		}
		const body = (await response.json()) as { data?: RemoteModel[] };
		if (!Array.isArray(body?.data)) {
			throw new Error(`Agnes ${MODELS_PATH} returned an unexpected response shape`);
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
}

/**
 * One provider per billing channel, each with its own registration, auth,
 * credential env var, and catalog state. The refresh contract follows
 * pi-ai's dynamic providers:
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
	const baseline = buildBaseline(channel.id);

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
			const restored = (stored?.models ?? []).filter((m) => isOwnChatModel(m, channel.id));
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

			const models = remote.filter(isChatModel).map((m) => remoteToChatModel(m, channel.id));
			if (models.length === 0) {
				// A chat-empty catalog is almost certainly an API anomaly; rejecting
				// it lets pi keep the previous list instead of registering nothing.
				throw new Error(`Agnes ${MODELS_PATH} returned no chat models`);
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
	// Token billing provider — pricing unpublished, so cost is 0.
	// Update when Agnes publishes official token pricing.
	pi.registerProvider(makeChannelProvider({ id: "agnes", name: "Agnes AI", apiKeyEnv: "AGNES_API_KEY" }));

	// Subscription plan provider — cost = 0.
	pi.registerProvider(
		makeChannelProvider({ id: "agnes-plan", name: "Agnes AI (Token Plan)", apiKeyEnv: "AGNES_PLAN_API_KEY" }),
	);
}
