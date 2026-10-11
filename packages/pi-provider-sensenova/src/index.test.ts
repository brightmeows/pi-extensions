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
	thinkingLevelMap?: Record<string, string | null>;
	compat?: { supportsDeveloperRole: boolean; supportsReasoningEffort: boolean };
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

function registeredProvider(): ProviderLike {
	const providers: ProviderLike[] = [];
	register({
		registerProvider(provider: ProviderLike) {
			providers.push(provider);
		},
	} as unknown as ExtensionAPI);
	assert.equal(providers.length, 1, "exactly one provider is registered");
	const provider = providers[0]!;
	assert.equal(provider.id, "sensenova-plan");
	return provider;
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
		{
			id: "deepseek-v4-flash",
			name: "DeepSeek V4 Flash",
			input_modalities: ["text"],
			output_modalities: ["text"],
			context_length: 1_048_576,
			max_output_length: 65_536,
			supported_features: ["tools", "json_mode", "reasoning"],
			pricing: { prompt: "0", completion: "0", input_cache_read: "0" },
		},
		{
			id: "sensenova-6.8-flash-lite",
			input_modalities: ["text", "image"],
			output_modalities: ["text"],
			context_length: 262_144,
			max_output_length: 65_536,
			supported_features: ["reasoning"],
			pricing: { prompt: "0", completion: "0" },
		},
		// Image-generation model: must be filtered out by output_modalities.
		{
			id: "sensenova-u1.5-lite",
			input_modalities: ["text"],
			output_modalities: ["image"],
			context_length: 262_144,
			max_output_length: 65_536,
			supported_features: ["reasoning"],
			pricing: { prompt: "0" },
		},
		// Older catalog shape without modalities: kept as chat (id does not match the image-gen heuristic).
		{ id: "legacy-model", context_length: 262_144, max_output_length: 65_536 },
		// Older catalog shape without modalities: excluded by the image-gen id heuristic.
		{ id: "sensenova-u1.5-legacy", context_length: 262_144, max_output_length: 65_536 },
	],
};

/** A persisted chat entry as written by a previous successful refresh. */
const STORED_CHAT_MODEL = {
	id: "deepseek-v4-pro",
	provider: "sensenova-plan",
	api: "openai-completions",
	baseUrl: "https://token.sensenova.cn/v1",
	name: "DeepSeek V4 Pro",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1_048_576,
	maxTokens: 393_216,
};

async function withFetchStub(response: unknown, run: () => Promise<void>): Promise<void> {
	const original = globalThis.fetch;
	globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => response }) as unknown as Response;
	try {
		await run();
	} finally {
		globalThis.fetch = original;
	}
}

test("registers a complete provider with baseline models, standard auth, and a refresh hook", () => {
	const provider = registeredProvider();
	assert.equal(provider.name, "SenseNova (Token Plan)");
	assert.equal(provider.baseUrl, "https://token.sensenova.cn/v1");
	assert.equal(typeof provider.refreshModels, "function");
	const models = provider.getModels();
	assert.ok(models.length > 0);
	assert.ok(models.some((model) => model.id === "kimi-k3"));
	// Delisted models are gone from the shipped baseline.
	assert.ok(!models.some((model) => model.id === "sensenova-6.7-flash-lite"));
	// Baseline entries are stamped for this provider.
	for (const model of models) {
		assert.equal(model.provider, "sensenova-plan");
		assert.equal(model.api, "openai-completions");
		assert.equal(model.baseUrl, "https://token.sensenova.cn/v1");
	}
});

test("unconfigured channels resolve to undefined so refresh skips them silently", async () => {
	const provider = registeredProvider();
	const resolve = provider.auth.apiKey.resolve;
	// No stored credential and the env var is unset.
	const unconfigured = await resolve({
		ctx: { env: async () => undefined },
		signal: new AbortController().signal,
	});
	assert.equal(unconfigured, undefined);
	// The ambient SENSENOVA_API_KEY env var resolves when nothing is stored.
	const fromEnv = await resolve({
		ctx: { env: async (name) => (name === "SENSENOVA_API_KEY" ? "sk-env" : undefined) },
		signal: new AbortController().signal,
	});
	assert.equal(fromEnv?.auth.apiKey, "sk-env");
	// A stored credential wins over the env var.
	const fromStored = await resolve({
		ctx: { env: async (name) => (name === "SENSENOVA_API_KEY" ? "sk-env" : undefined) },
		credential: { type: "api_key", key: "sk-stored" },
		signal: new AbortController().signal,
	});
	assert.equal(fromStored?.auth.apiKey, "sk-stored");
	assert.equal(fromStored?.source, "stored credential");
});

test("offline phase without a stored catalog keeps the baseline list", async () => {
	const provider = registeredProvider();
	const { context, publications } = makeRefreshContext();
	await provider.refreshModels!(context);
	assert.equal(publications.length, 0);
	assert.ok(provider.getModels().some((m) => m.id === "kimi-k3"));
});

test("offline phase restores persisted chat entries and drops foreign or unreadable ones", async () => {
	const provider = registeredProvider();
	const { context, publications } = makeRefreshContext({
		stored: {
			models: [STORED_CHAT_MODEL, { id: "other-provider-model", provider: "elsewhere", api: "openai-completions" }, { id: "legacy" }],
			checkedAt: Date.now(),
		},
	});
	await provider.refreshModels!(context);
	// Restore publishes an in-memory update only — no persistence mutation.
	assert.equal(publications.length, 1);
	assert.equal(publications[0]!.persist, undefined);
	const models = provider.getModels();
	assert.equal(models.length, 1);
	assert.equal(models[0]!.id, "deepseek-v4-pro");
	assert.equal(models[0]!.provider, "sensenova-plan");
});

test("pre-rewrite snapshots are dropped and refetched instead of idling out the window", async () => {
	const provider = registeredProvider();
	const { context, publications } = makeRefreshContext({
		allowNetwork: true,
		// Old shape: no provider/api stamps, but a fresh checkedAt.
		stored: { models: [{ id: "deepseek-v4-pro", name: "DeepSeek V4 Pro" }], checkedAt: Date.now() },
	});
	await withFetchStub(LIVE_CATALOG, () => provider.refreshModels!(context));
	const persists = publications.filter((p) => p.persist !== undefined);
	assert.equal(persists[0]!.persist, null);
	const replacement = persists.at(-1)!.persist;
	assert.notEqual(replacement, null);
	assert.equal(replacement!.models!.length, 3);
	assert.ok(replacement!.models!.some((m) => (m as ModelLike).id === "deepseek-v4-flash"));
});

test("network phase maps the live catalog, filters image models, and publishes a snapshot", async () => {
	const provider = registeredProvider();
	const { context, publications } = makeRefreshContext({ allowNetwork: true });
	await withFetchStub(LIVE_CATALOG, () => provider.refreshModels!(context));
	const persist = publications.at(-1)!.persist;
	assert.notEqual(persist, null);
	assert.equal(typeof persist!.checkedAt, "number");
	const persisted = persist!.models as ModelLike[];
	assert.equal(persisted.length, 3);
	assert.ok(persisted.some((m) => m.id === "deepseek-v4-flash"));
	assert.ok(persisted.some((m) => m.id === "legacy-model"));
	assert.ok(!persisted.some((m) => m.id === "sensenova-u1.5-lite"));
	assert.ok(!persisted.some((m) => m.id === "sensenova-u1.5-legacy"));
	// The live list is replaced with the mapped catalog.
	assert.deepEqual(
		provider.getModels().map((m) => m.id).sort(),
		persisted.map((m) => m.id).sort(),
	);
	for (const model of provider.getModels()) {
		assert.equal(model.provider, "sensenova-plan");
	}
});

test("network phase fails fast when no API key credential is available", async () => {
	const provider = registeredProvider();
	const { context } = makeRefreshContext({ allowNetwork: true, credential: undefined });
	await assert.rejects(
		() => withFetchStub(LIVE_CATALOG, () => provider.refreshModels!(context)),
		/SENSENOVA_API_KEY is not configured for sensenova-plan/,
	);
});

test("network phase surfaces HTTP errors so pi keeps the previous list", async () => {
	const provider = registeredProvider();
	const restore = makeRefreshContext({ stored: { models: [STORED_CHAT_MODEL], checkedAt: 0 } });
	await provider.refreshModels!(restore.context);
	const { context } = makeRefreshContext({ allowNetwork: true, stored: { models: [STORED_CHAT_MODEL], checkedAt: 0 } });
	const original = globalThis.fetch;
	globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) }) as unknown as Response;
	try {
		await assert.rejects(() => provider.refreshModels!(context), /returned HTTP 500/);
	} finally {
		globalThis.fetch = original;
	}
	// The previous list survives the failure.
	assert.deepEqual(provider.getModels().map((m) => m.id), ["deepseek-v4-pro"]);
});

test("network phase rejects unexpected response shapes", async () => {
	const provider = registeredProvider();
	const { context } = makeRefreshContext({ allowNetwork: true });
	await assert.rejects(
		() => withFetchStub({ objects: [] }, () => provider.refreshModels!(context)),
		/unexpected response shape/,
	);
});

test("network phase skips fetching while the persisted snapshot is fresh", async () => {
	const provider = registeredProvider();
	const { context, publications } = makeRefreshContext({
		allowNetwork: true,
		stored: { models: [STORED_CHAT_MODEL], checkedAt: Date.now() },
	});
	let fetchCalls = 0;
	const original = globalThis.fetch;
	globalThis.fetch = async () => {
		fetchCalls++;
		return { ok: true, status: 200, json: async () => LIVE_CATALOG } as unknown as Response;
	};
	try {
		await provider.refreshModels!(context);
	} finally {
		globalThis.fetch = original;
	}
	assert.equal(fetchCalls, 0);
	assert.equal(publications.filter((p) => p.persist !== undefined).length, 0);
	assert.deepEqual(provider.getModels().map((m) => m.id), ["deepseek-v4-pro"]);
});

test("forced refresh bypasses the freshness window", async () => {
	const provider = registeredProvider();
	const { context } = makeRefreshContext({
		allowNetwork: true,
		force: true,
		stored: { models: [STORED_CHAT_MODEL], checkedAt: Date.now() },
	});
	await withFetchStub(LIVE_CATALOG, () => provider.refreshModels!(context));
	assert.ok(provider.getModels().some((m) => m.id === "deepseek-v4-flash"));
});

test("missing remote metadata falls back to shipped specs for known ids", async () => {
	const provider = registeredProvider();
	const { context } = makeRefreshContext({ allowNetwork: true });
	await withFetchStub({ data: [{ id: "kimi-k3" }] }, () => provider.refreshModels!(context));
	const kimi = provider.getModels().find((m) => m.id === "kimi-k3");
	assert.ok(kimi);
	assert.equal(kimi.name, "Kimi K3");
	assert.equal(kimi.contextWindow, 1_048_576);
	assert.equal(kimi.maxTokens, 65_536);
	assert.deepEqual(kimi.input, ["text"]);
});

test("chat-empty catalogs are rejected so the previous list is kept", async () => {
	const provider = registeredProvider();
	const { context } = makeRefreshContext({ allowNetwork: true });
	await assert.rejects(
		() => withFetchStub({ data: [{ id: "sensenova-u1.5-lite", output_modalities: ["image"] }] }, () => provider.refreshModels!(context)),
		/no chat models/,
	);
});
