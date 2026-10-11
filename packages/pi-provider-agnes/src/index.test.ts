import * as assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import register from "./index.ts";

interface ModelLike {
	id: string;
	provider: string;
	api: string;
	baseUrl: string;
	name: string;
	reasoning: boolean;
	input: string[];
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow: number;
	maxTokens: number;
	compat?: Record<string, unknown>;
}

interface PublicationLike {
	persist?: { models?: unknown[]; checkedAt?: number } | null;
	update?: () => void;
}

interface RefreshContextLike {
	allowNetwork: boolean;
	stored?: { models?: unknown[]; checkedAt?: number };
	force?: boolean;
	credential?: { type: "api_key" | "oauth"; key?: string };
	signal: AbortSignal;
	publish: (publication: PublicationLike) => Promise<boolean>;
}

interface AuthResolveArgs {
	ctx: { env: (name: string) => Promise<string | undefined> };
	credential?: { type: string; key?: string };
	signal: AbortSignal;
}

interface ProviderLike {
	id: string;
	name: string;
	baseUrl: string;
	auth: {
		apiKey: {
			name: string;
			resolve: (args: AuthResolveArgs) => Promise<{ auth: { apiKey: string }; source: string } | undefined>;
		};
	};
	getModels(): ModelLike[];
	refreshModels?: (context: RefreshContextLike) => Promise<void>;
}

function registeredProviders(): Record<string, ProviderLike> {
	const providers: Record<string, ProviderLike> = {};
	register({
		registerProvider(provider: ProviderLike) {
			providers[provider.id] = provider;
		},
	} as unknown as ExtensionAPI);
	assert.deepEqual(Object.keys(providers).sort(), ["agnes", "agnes-plan"]);
	return providers;
}

function makeRefreshContext(overrides: Partial<RefreshContextLike> = {}) {
	const publications: PublicationLike[] = [];
	const context: RefreshContextLike = {
		allowNetwork: false,
		credential: { type: "api_key", key: "sk-test" },
		signal: new AbortController().signal,
		publish: async (publication) => {
			publications.push(publication);
			publication.update?.();
			return true;
		},
		...overrides,
	};
	return { context, publications };
}

const LIVE_CATALOG = {
	data: [
		{ id: "agnes-2.5-flash" },
		{ id: "agnes-3.0-flash" },
		{ id: "agnes-9-future" }, // unknown id → family defaults
		{ id: "agnes-image-pro" }, // image generation → excluded
		{ id: "agnes-video-pro" }, // video generation → excluded
	],
};

/** A persisted chat entry as written by a previous successful refresh. */
function storedChatModel(providerId: string): ModelLike {
	return {
		id: "agnes-2.5-pro",
		provider: providerId,
		api: "openai-completions",
		baseUrl: "https://apihub.agnes-ai.com/v1",
		name: "Agnes 2.5 Pro",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 262_144,
		maxTokens: 65_536,
	};
}

async function withFetchStub(response: unknown, run: () => Promise<void>): Promise<void> {
	const original = globalThis.fetch;
	globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => response }) as unknown as Response;
	try {
		await run();
	} finally {
		globalThis.fetch = original;
	}
}

test("registers two independent complete providers over the same catalog", () => {
	const providers = registeredProviders();
	for (const [id, provider] of Object.entries(providers)) {
		assert.equal(provider.id, id);
		assert.equal(provider.baseUrl, "https://apihub.agnes-ai.com/v1");
		assert.equal(typeof provider.refreshModels, "function");
		const models = provider.getModels();
		assert.ok(models.length > 0);
		assert.ok(models.some((m) => m.id === "agnes-3.0-flash-max"));
		// Baseline entries are stamped per channel.
		for (const model of models) {
			assert.equal(model.provider, id);
			assert.equal(model.api, "openai-completions");
		}
	}
	assert.equal(providers["agnes"]!.name, "Agnes AI");
	assert.equal(providers["agnes-plan"]!.name, "Agnes AI (Token Plan)");
});

test("each channel resolves its own ambient env var and skips silently when unconfigured", async () => {
	const providers = registeredProviders();
	const env = async (name: string) =>
		name === "AGNES_PLAN_API_KEY" ? "sk-plan-env" : name === "AGNES_API_KEY" ? "sk-payg-env" : undefined;
	for (const [id, expected] of [
		["agnes", "sk-payg-env"],
		["agnes-plan", "sk-plan-env"],
	] as const) {
		const provider = providers[id]!;
		// Unconfigured: no stored credential, no env var.
		assert.equal(
			await provider.auth.apiKey.resolve({ ctx: { env: async () => undefined }, signal: new AbortController().signal }),
			undefined,
		);
		// Ambient env for THIS channel only; a stored credential wins.
		assert.equal(
			(await provider.auth.apiKey.resolve({ ctx: { env }, signal: new AbortController().signal }))?.auth.apiKey,
			expected,
		);
		assert.equal(
			(await provider.auth.apiKey.resolve({
				ctx: { env },
				credential: { type: "api_key", key: "sk-stored" },
				signal: new AbortController().signal,
			}))?.auth.apiKey,
			"sk-stored",
		);
	}
});

test("offline phase without a stored catalog keeps the baseline list", async () => {
	const { "agnes-plan": provider } = registeredProviders();
	const { context, publications } = makeRefreshContext();
	await provider.refreshModels!(context);
	assert.equal(publications.length, 0);
	assert.ok(provider.getModels().some((m) => m.id === "agnes-2.5-flash"));
});

test("offline phase restores only this channel's persisted entries", async () => {
	const providers = registeredProviders();
	const { context } = makeRefreshContext({
		stored: { models: [storedChatModel("agnes")], checkedAt: Date.now() }, // the OTHER channel's snapshot
	});
	await providers["agnes-plan"]!.refreshModels!(context);
	// Unusable snapshot: baseline restored in memory and the entry dropped.
	assert.deepEqual(providers["agnes-plan"]!.getModels().map((m) => m.id).sort(), ["agnes-2.0-flash", "agnes-2.5-flash", "agnes-2.5-pro", "agnes-2.5-pro-alpha", "agnes-2.5-pro-beta", "agnes-3.0-flash", "agnes-3.0-flash-max"]);

	const own = makeRefreshContext({ stored: { models: [storedChatModel("agnes-plan")], checkedAt: Date.now() } });
	await providers["agnes-plan"]!.refreshModels!(own.context);
	assert.deepEqual(providers["agnes-plan"]!.getModels().map((m) => m.id), ["agnes-2.5-pro"]);
});

test("network phase maps ids-only catalogs with shipped-spec preference", async () => {
	const { "agnes-plan": provider } = registeredProviders();
	const { context, publications } = makeRefreshContext({ allowNetwork: true });
	await withFetchStub(LIVE_CATALOG, () => provider.refreshModels!(context));
	const persist = publications.at(-1)!.persist;
	assert.notEqual(persist, null);
	const persisted = persist!.models as ModelLike[];
	assert.deepEqual(
		persisted.map((m) => m.id).sort(),
		["agnes-2.5-flash", "agnes-3.0-flash", "agnes-9-future"],
	);
	for (const model of persisted) {
		assert.equal(model.provider, "agnes-plan");
		assert.equal(model.baseUrl, "https://apihub.agnes-ai.com/v1");
	}
	// Known id: shipped specs fill every omitted field.
	const flash = persisted.find((m) => m.id === "agnes-2.5-flash")!;
	assert.equal(flash.name, "Agnes 2.5 Flash");
	assert.equal(flash.contextWindow, 512_000);
	assert.equal(flash.maxTokens, 65_500);
	assert.deepEqual(flash.input, ["text", "image"]);
	assert.equal(flash.compat!.thinkingFormat, "qwen-chat-template");
	// Unknown id: family defaults.
	const future = persisted.find((m) => m.id === "agnes-9-future")!;
	assert.equal(future.name, "agnes-9-future");
	assert.equal(future.contextWindow, 262_144);
	assert.equal(future.maxTokens, 65_536);
});

test("network phase fails fast when no API key credential is available", async () => {
	const { "agnes-plan": provider } = registeredProviders();
	const { context } = makeRefreshContext({ allowNetwork: true, credential: undefined });
	await assert.rejects(
		() => withFetchStub(LIVE_CATALOG, () => provider.refreshModels!(context)),
		/API key is not configured for agnes-plan/,
	);
});

test("network phase surfaces HTTP errors so pi keeps the previous list", async () => {
	const { agnes: provider } = registeredProviders();
	const restore = makeRefreshContext({ stored: { models: [storedChatModel("agnes")], checkedAt: 0 } });
	await provider.refreshModels!(restore.context);
	const { context } = makeRefreshContext({ allowNetwork: true, stored: { models: [storedChatModel("agnes")], checkedAt: 0 } });
	const original = globalThis.fetch;
	globalThis.fetch = async () => ({ ok: false, status: 401, json: async () => ({}) }) as unknown as Response;
	try {
		await assert.rejects(() => provider.refreshModels!(context), /returned HTTP 401/);
	} finally {
		globalThis.fetch = original;
	}
	assert.deepEqual(provider.getModels().map((m) => m.id), ["agnes-2.5-pro"]);
});

test("network phase skips fetching while the persisted snapshot is fresh, force bypasses it", async () => {
	const { agnes: provider } = registeredProviders();
	let fetchCalls = 0;
	const original = globalThis.fetch;
	globalThis.fetch = async () => {
		fetchCalls++;
		return { ok: true, status: 200, json: async () => LIVE_CATALOG } as unknown as Response;
	};
	try {
		const fresh = makeRefreshContext({ allowNetwork: true, stored: { models: [storedChatModel("agnes")], checkedAt: Date.now() } });
		await provider.refreshModels!(fresh.context);
		assert.equal(fetchCalls, 0);
		const forced = makeRefreshContext({
			allowNetwork: true,
			force: true,
			stored: { models: [storedChatModel("agnes")], checkedAt: Date.now() },
		});
		await provider.refreshModels!(forced.context);
		assert.equal(fetchCalls, 1);
		assert.ok(provider.getModels().some((m) => m.id === "agnes-9-future"));
	} finally {
		globalThis.fetch = original;
	}
});

test("chat-empty catalogs are rejected so the previous list is kept", async () => {
	const { agnes: provider } = registeredProviders();
	const { context } = makeRefreshContext({ allowNetwork: true });
	await assert.rejects(
		() => withFetchStub({ data: [{ id: "agnes-image-pro" }, { id: "agnes-video-pro" }] }, () => provider.refreshModels!(context)),
		/no chat models/,
	);
});
