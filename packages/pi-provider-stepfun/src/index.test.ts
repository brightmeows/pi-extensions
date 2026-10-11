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
	assert.deepEqual(Object.keys(providers).sort(), ["stepfun", "stepfun-plan"]);
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

const STANDARD_BASE = "https://api.stepfun.com/v1";
const PLAN_BASE = "https://api.stepfun.com/step_plan/v1";

const LIVE_CATALOG = {
	data: [
		{
			id: "step-5-preview",
			name: "Step 5 Preview",
			input_modalities: ["text", "image"],
			output_modalities: ["text"],
			context_length: 1_000_000,
			max_output_length: 65_536,
		},
		{ id: "step-future-x" }, // unknown id, no metadata → defaults
		{ id: "step-embed-v2", output_modalities: ["embedding"] }, // non-chat → excluded when modalities present
	],
};

/** A persisted chat entry as written by a previous successful refresh. */
function storedChatModel(providerId: string, baseUrl: string): ModelLike {
	return {
		id: "step-3.7-flash",
		provider: providerId,
		api: "openai-completions",
		baseUrl,
		name: "Step 3.7 Flash",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 262_144,
		maxTokens: 16_384,
	};
}

async function withFetchStub(response: unknown, urls: string[], run: () => Promise<void>): Promise<void> {
	const original = globalThis.fetch;
	globalThis.fetch = async (input: unknown) => {
		urls.push(String(input));
		return { ok: true, status: 200, json: async () => response } as unknown as Response;
	};
	try {
		await run();
	} finally {
		globalThis.fetch = original;
	}
}

test("registers two independent complete providers with channel-specific catalogs", () => {
	const providers = registeredProviders();
	const standard = providers["stepfun"]!;
	const plan = providers["stepfun-plan"]!;

	assert.equal(standard.name, "StepFun");
	assert.equal(standard.baseUrl, STANDARD_BASE);
	assert.equal(plan.name, "StepFun (Step Plan)");
	assert.equal(plan.baseUrl, PLAN_BASE);

	const standardIds = standard.getModels().map((m) => m.id);
	const planIds = plan.getModels().map((m) => m.id);
	// Channel-exclusive models.
	assert.ok(standardIds.includes("step-1o-turbo-vision"));
	assert.ok(!planIds.includes("step-1o-turbo-vision"));
	assert.ok(planIds.includes("step-router-v1"));
	assert.ok(!standardIds.includes("step-router-v1"));
	// Shared models.
	for (const id of ["step-5-preview", "step-3.5-flash", "step-3.5-flash-2603"]) {
		assert.ok(standardIds.includes(id), `${id} on standard`);
		assert.ok(planIds.includes(id), `${id} on plan`);
	}
	// Baseline entries are stamped per channel.
	for (const model of standard.getModels()) {
		assert.equal(model.provider, "stepfun");
		assert.equal(model.baseUrl, STANDARD_BASE);
	}
	for (const model of plan.getModels()) {
		assert.equal(model.provider, "stepfun-plan");
		assert.equal(model.baseUrl, PLAN_BASE);
	}
});

test("each channel resolves its own ambient env var and skips silently when unconfigured", async () => {
	const providers = registeredProviders();
	const env = async (name: string) =>
		name === "STEP_PLAN_API_KEY" ? "sk-plan-env" : name === "STEP_API_KEY" ? "sk-payg-env" : undefined;
	for (const [id, expected] of [
		["stepfun", "sk-payg-env"],
		["stepfun-plan", "sk-plan-env"],
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

test("network phase fetches the channel's own catalog URL and maps entries", async () => {
	const providers = registeredProviders();
	const urls: string[] = [];

	const standard = makeRefreshContext({ allowNetwork: true });
	await withFetchStub(LIVE_CATALOG, urls, () => providers["stepfun"]!.refreshModels!(standard.context));
	assert.deepEqual(urls, [`${STANDARD_BASE}/models`]);
	const standardModels = (standard.publications.at(-1)!.persist!.models as ModelLike[]);
	assert.deepEqual(
		standardModels.map((m) => m.id).sort(),
		["step-5-preview", "step-future-x"],
	);
	for (const model of standardModels) {
		assert.equal(model.provider, "stepfun");
		assert.equal(model.baseUrl, STANDARD_BASE);
	}
	// Unknown id without metadata → defaults + shipped compat.
	const future = standardModels.find((m) => m.id === "step-future-x")!;
	assert.equal(future.contextWindow, 262_144);
	assert.equal(future.maxTokens, 16_384);
	assert.equal(future.compat!.maxTokensField, "max_tokens");

	urls.length = 0;
	const plan = makeRefreshContext({ allowNetwork: true });
	await withFetchStub(LIVE_CATALOG, urls, () => providers["stepfun-plan"]!.refreshModels!(plan.context));
	assert.deepEqual(urls, [`${PLAN_BASE}/models`]);
	assert.deepEqual(
		(plan.publications.at(-1)!.persist!.models as ModelLike[]).map((m) => m.id).sort(),
		["step-5-preview", "step-future-x"],
	);
});

test("network phase fails fast when no API key credential is available", async () => {
	const { "stepfun-plan": provider } = registeredProviders();
	const { context } = makeRefreshContext({ allowNetwork: true, credential: undefined });
	await assert.rejects(
		() => withFetchStub(LIVE_CATALOG, [], () => provider.refreshModels!(context)),
		/STEP_PLAN_API_KEY is not configured for stepfun-plan/,
	);
});

test("network phase surfaces HTTP errors so pi keeps the previous list", async () => {
	const { stepfun: provider } = registeredProviders();
	const restore = makeRefreshContext({ stored: { models: [storedChatModel("stepfun", STANDARD_BASE)], checkedAt: 0 } });
	await provider.refreshModels!(restore.context);
	const { context } = makeRefreshContext({
		allowNetwork: true,
		stored: { models: [storedChatModel("stepfun", STANDARD_BASE)], checkedAt: 0 },
	});
	const original = globalThis.fetch;
	globalThis.fetch = async () => ({ ok: false, status: 403, json: async () => ({}) }) as unknown as Response;
	try {
		await assert.rejects(() => provider.refreshModels!(context), /returned HTTP 403/);
	} finally {
		globalThis.fetch = original;
	}
	assert.deepEqual(provider.getModels().map((m) => m.id), ["step-3.7-flash"]);
});

test("offline phase restores only this channel's persisted entries", async () => {
	const providers = registeredProviders();
	// The plan channel sees the standard channel's snapshot: unusable → dropped.
	const foreign = makeRefreshContext({ stored: { models: [storedChatModel("stepfun", STANDARD_BASE)], checkedAt: Date.now() } });
	await providers["stepfun-plan"]!.refreshModels!(foreign.context);
	assert.equal(foreign.publications.filter((p) => p.persist !== undefined).at(-1)!.persist, null);
	assert.ok(providers["stepfun-plan"]!.getModels().some((m) => m.id === "step-router-v1"));

	const own = makeRefreshContext({ stored: { models: [storedChatModel("stepfun-plan", PLAN_BASE)], checkedAt: Date.now() } });
	await providers["stepfun-plan"]!.refreshModels!(own.context);
	assert.deepEqual(providers["stepfun-plan"]!.getModels().map((m) => m.id), ["step-3.7-flash"]);
});

test("network phase skips fetching while fresh, force bypasses the window", async () => {
	const { stepfun: provider } = registeredProviders();
	let fetchCalls = 0;
	const original = globalThis.fetch;
	globalThis.fetch = async () => {
		fetchCalls++;
		return { ok: true, status: 200, json: async () => LIVE_CATALOG } as unknown as Response;
	};
	try {
		const fresh = makeRefreshContext({
			allowNetwork: true,
			stored: { models: [storedChatModel("stepfun", STANDARD_BASE)], checkedAt: Date.now() },
		});
		await provider.refreshModels!(fresh.context);
		assert.equal(fetchCalls, 0);
		const forced = makeRefreshContext({
			allowNetwork: true,
			force: true,
			stored: { models: [storedChatModel("stepfun", STANDARD_BASE)], checkedAt: Date.now() },
		});
		await provider.refreshModels!(forced.context);
		assert.equal(fetchCalls, 1);
	} finally {
		globalThis.fetch = original;
	}
});

test("chat-empty catalogs are rejected so the previous list is kept", async () => {
	const { stepfun: provider } = registeredProviders();
	const { context } = makeRefreshContext({ allowNetwork: true });
	await assert.rejects(
		() => withFetchStub({ data: [{ id: "step-embed-v2", output_modalities: ["embedding"] }] }, [], () => provider.refreshModels!(context)),
		/no chat models/,
	);
});
