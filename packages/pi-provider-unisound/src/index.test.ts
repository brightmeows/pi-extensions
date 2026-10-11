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
	assert.deepEqual(Object.keys(providers).sort(), ["unisound", "unisound-plan"]);
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

const BASE_URL = "https://maas-api.unisound.com/v1";

const LIVE_CATALOG = {
	data: [
		// Catalog values override shipped specs.
		{ id: "u2-flash", context_window: 400_000, max_output: 100_000 },
		// No metadata → shipped specs fill the gaps.
		{ id: "kimi-k3" },
		// New model unknown to the shipped table → generic defaults.
		{ id: "future-model-x", context_window: 300_000, max_output: 32_000 },
	],
};

/** A persisted chat entry as written by a previous successful refresh. */
function storedChatModel(providerId: string, id: string, cost: ModelLike["cost"]): ModelLike {
	return {
		id,
		provider: providerId,
		api: "openai-completions",
		baseUrl: BASE_URL,
		name: id,
		reasoning: true,
		input: ["text"],
		cost,
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

test("registers two independent complete providers with channel-specific costs", () => {
	const providers = registeredProviders();
	const payg = providers["unisound"]!;
	const plan = providers["unisound-plan"]!;

	assert.equal(payg.name, "Unisound MaaS");
	assert.equal(payg.baseUrl, BASE_URL);
	assert.equal(plan.name, "Unisound MaaS (Token Plan)");

	const paygFlash = payg.getModels().find((m) => m.id === "u2-flash")!;
	assert.deepEqual(paygFlash.cost, { input: 0.14, output: 0.28, cacheRead: 0.03, cacheWrite: 0 });
	const planFlash = plan.getModels().find((m) => m.id === "u2-flash")!;
	assert.deepEqual(planFlash.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

	// Same platform model set on both channels, stamped per channel.
	assert.deepEqual(
		payg.getModels().map((m) => m.id).sort(),
		plan.getModels().map((m) => m.id).sort(),
	);
	for (const model of payg.getModels()) assert.equal(model.provider, "unisound");
	for (const model of plan.getModels()) assert.equal(model.provider, "unisound-plan");
});

test("each channel resolves its own ambient env var and skips silently when unconfigured", async () => {
	const providers = registeredProviders();
	const env = async (name: string) =>
		name === "UNISOUND_PLAN_API_KEY" ? "sk-plan-env" : name === "UNISOUND_API_KEY" ? "sk-payg-env" : undefined;
	for (const [id, expected] of [
		["unisound", "sk-payg-env"],
		["unisound-plan", "sk-plan-env"],
	] as const) {
		const provider = providers[id]!;
		assert.equal(
			await provider.auth.apiKey.resolve({ ctx: { env: async () => undefined }, signal: new AbortController().signal }),
			undefined,
		);
		assert.equal(
			(await provider.auth.apiKey.resolve({ ctx: { env }, signal: new AbortController().signal }))?.auth.apiKey,
			expected,
		);
	}
});

test("network phase maps the catalog with channel costs and publishes a snapshot", async () => {
	const providers = registeredProviders();
	const payg = makeRefreshContext({ allowNetwork: true });
	await withFetchStub(LIVE_CATALOG, () => providers["unisound"]!.refreshModels!(payg.context));
	const paygModels = payg.publications.at(-1)!.persist!.models as ModelLike[];
	assert.equal(typeof payg.publications.at(-1)!.persist!.checkedAt, "number");
	assert.deepEqual(
		paygModels.map((m) => m.id).sort(),
		["future-model-x", "kimi-k3", "u2-flash"],
	);
	// Catalog numbers win; channel costs apply.
	const flash = paygModels.find((m) => m.id === "u2-flash")!;
	assert.equal(flash.contextWindow, 400_000);
	assert.equal(flash.maxTokens, 100_000);
	assert.equal(flash.cost.input, 0.14);
	// Known id without metadata → shipped specs (kimi-k3: 1M/1M image-input).
	const kimi = paygModels.find((m) => m.id === "kimi-k3")!;
	assert.equal(kimi.contextWindow, 1_048_576);
	assert.equal(kimi.maxTokens, 1_048_576);
	assert.deepEqual(kimi.input, ["text", "image"]);

	const plan = makeRefreshContext({ allowNetwork: true });
	await withFetchStub(LIVE_CATALOG, () => providers["unisound-plan"]!.refreshModels!(plan.context));
	const planModels = plan.publications.at(-1)!.persist!.models as ModelLike[];
	assert.equal(planModels.find((m) => m.id === "u2-flash")!.cost.input, 0);
	for (const model of planModels) assert.equal(model.provider, "unisound-plan");
});

test("restore phase re-resolves channel costs from the shipped table", async () => {
	const providers = registeredProviders();
	// A plan snapshot whose persisted cost predates a channel-cost change.
	const stale = makeRefreshContext({
		stored: {
			models: [storedChatModel("unisound-plan", "u2-flash", { input: 0.14, output: 0.28, cacheRead: 0.03, cacheWrite: 0 })],
			checkedAt: Date.now(),
		},
	});
	await providers["unisound-plan"]!.refreshModels!(stale.context);
	assert.deepEqual(providers["unisound-plan"]!.getModels()[0]!.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

	// A payg snapshot with a stale zero cost picks the PAYG table back up.
	const payg = makeRefreshContext({
		stored: { models: [storedChatModel("unisound", "u2-flash", { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })], checkedAt: Date.now() },
	});
	await providers["unisound"]!.refreshModels!(payg.context);
	assert.equal(providers["unisound"]!.getModels()[0]!.cost.input, 0.14);
});

test("restore phase drops foreign or pre-rewrite entries and refetches", async () => {
	const providers = registeredProviders();
	const { context, publications } = makeRefreshContext({
		allowNetwork: true,
		stored: { models: [storedChatModel("unisound", "u2-flash", { input: 0.14, output: 0.28, cacheRead: 0.03, cacheWrite: 0 })], checkedAt: Date.now() },
	});
	await withFetchStub(LIVE_CATALOG, () => providers["unisound-plan"]!.refreshModels!(context));
	assert.equal(publications.filter((p) => p.persist !== undefined)[0]!.persist, null);
	assert.ok(providers["unisound-plan"]!.getModels().some((m) => m.id === "kimi-k3"));
});

test("network phase fails fast when no API key credential is available", async () => {
	const { "unisound-plan": provider } = registeredProviders();
	const { context } = makeRefreshContext({ allowNetwork: true, credential: undefined });
	await assert.rejects(
		() => withFetchStub(LIVE_CATALOG, () => provider.refreshModels!(context)),
		/API key is not configured for unisound-plan/,
	);
});

test("network phase surfaces HTTP errors so pi keeps the previous list", async () => {
	const { unisound: provider } = registeredProviders();
	const restore = makeRefreshContext({
		stored: { models: [storedChatModel("unisound", "u2", { input: 0.14, output: 0.28, cacheRead: 0.003, cacheWrite: 0 })], checkedAt: 0 },
	});
	await provider.refreshModels!(restore.context);
	const { context } = makeRefreshContext({
		allowNetwork: true,
		stored: { models: [storedChatModel("unisound", "u2", { input: 0.14, output: 0.28, cacheRead: 0.003, cacheWrite: 0 })], checkedAt: 0 },
	});
	const original = globalThis.fetch;
	globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) }) as unknown as Response;
	try {
		await assert.rejects(() => provider.refreshModels!(context), /returned HTTP 500/);
	} finally {
		globalThis.fetch = original;
	}
	assert.deepEqual(provider.getModels().map((m) => m.id), ["u2"]);
});

test("network phase skips fetching while fresh, force bypasses the window", async () => {
	const { unisound: provider } = registeredProviders();
	let fetchCalls = 0;
	const original = globalThis.fetch;
	globalThis.fetch = async () => {
		fetchCalls++;
		return { ok: true, status: 200, json: async () => LIVE_CATALOG } as unknown as Response;
	};
	try {
		const fresh = makeRefreshContext({
			allowNetwork: true,
			stored: { models: [storedChatModel("unisound", "u2", { input: 0.14, output: 0.28, cacheRead: 0.003, cacheWrite: 0 })], checkedAt: Date.now() },
		});
		await provider.refreshModels!(fresh.context);
		assert.equal(fetchCalls, 0);
		const forced = makeRefreshContext({
			allowNetwork: true,
			force: true,
			stored: { models: [storedChatModel("unisound", "u2", { input: 0.14, output: 0.28, cacheRead: 0.003, cacheWrite: 0 })], checkedAt: Date.now() },
		});
		await provider.refreshModels!(forced.context);
		assert.equal(fetchCalls, 1);
	} finally {
		globalThis.fetch = original;
	}
});

test("empty catalogs are rejected so the previous list is kept", async () => {
	const { unisound: provider } = registeredProviders();
	const { context } = makeRefreshContext({ allowNetwork: true });
	await assert.rejects(
		() => withFetchStub({ data: [] }, () => provider.refreshModels!(context)),
		/returned no models/,
	);
});
