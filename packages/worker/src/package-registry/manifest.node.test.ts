import { expect, test } from 'vitest'
import {
	buildPackageSearchProjection,
	getPackageAppAssetsDirectory,
	getPackageAppClientEntryPath,
	getPackageAppClientExternals,
	getPackageAppEntryPath,
	listPackageEmittedEvents,
	parseAuthoredPackageJson,
} from './manifest.ts'
import {
	assertKodyDescriptionLength,
	KODY_DESCRIPTION_MAX_LENGTH,
} from './types.ts'

function parse(
	name: string,
	kody: Record<string, unknown> = {},
	{
		exports = { '.': './index.ts' },
		...options
	}: {
		exports?: unknown
		expectedPackageScope?: string
		mode?: 'authoring' | 'published'
	} = {},
) {
	return parseAuthoredPackageJson({
		content: JSON.stringify({
			name,
			exports,
			kody: {
				id: name.split('/').pop(),
				description: 'Test package',
				...kody,
			},
		}),
		manifestPath: 'package.json',
		...options,
	})
}

const sentryExports = {
	exports: { './handle-sentry-webhook': './src/handle-sentry-webhook.ts' },
}
const sentryHook = (extra: Record<string, unknown> = {}) => ({
	webhooks: [{ name: 'sentry', export: './handle-sentry-webhook', ...extra }],
})
const hmac = (header: string, secretName: string) => ({
	type: 'hmac-sha256',
	header,
	secretName,
	encoding: 'hex',
})
const webhookDefaults = {
	description: null,
	responseMode: 'ack',
	inputMode: 'request',
	rateLimitPerMinute: 60,
	verification: null,
	replay: null,
	challenge: null,
}
const discordEvent = { description: 'A Discord message was created.' }
const messageIdSchema = {
	type: 'object',
	properties: { messageId: { type: 'string', minLength: 1 } },
	required: ['messageId'],
	additionalProperties: false,
}

test('parseAuthoredPackageJson accepts kody.app.client and kody.app.assets next to the Worker entry', () => {
	const manifest = parse('@kentcdodds/browser-app', {
		app: {
			entry: './src/app.ts',
			client: './src/client.tsx',
			assets: './public/',
		},
	})
	expect(manifest.kody.app).toEqual({
		entry: './src/app.ts',
		client: './src/client.tsx',
		assets: './public/',
	})
	expect(getPackageAppEntryPath(manifest)).toBe('src/app.ts')
	expect(getPackageAppClientEntryPath(manifest)).toBe('src/client.tsx')
	expect(getPackageAppAssetsDirectory(manifest)).toBe('public')
	expect(getPackageAppClientExternals(manifest)).toEqual([])

	const workerOnly = parse('@kentcdodds/worker-app', {
		app: { entry: './src/app.ts' },
	})
	expect(workerOnly.kody.app).toEqual({ entry: './src/app.ts' })
	expect(getPackageAppClientEntryPath(workerOnly)).toBeNull()
	expect(getPackageAppAssetsDirectory(workerOnly)).toBeNull()

	const withExternals = parse('@kentcdodds/import-map-app', {
		app: {
			entry: './src/app.ts',
			client: {
				entry: './src/client.tsx',
				externals: ['preact', ' lit ', 'preact'],
			},
		},
	})
	expect(getPackageAppClientEntryPath(withExternals)).toBe('src/client.tsx')
	expect(getPackageAppClientExternals(withExternals)).toEqual(['lit', 'preact'])

	// `published` snapshot loads treat leftover kody.app.runtime as inert.
	const published = parse(
		'@kentcdodds/runtime-app',
		{ app: { runtime: 'remix', entry: './app/router.ts' } },
		{ mode: 'published' },
	)
	expect(published.kody.app).toEqual({ entry: './app/router.ts' })
})

test('parseAuthoredPackageJson validates scoped package names against kody.id', () => {
	const scope = { expectedPackageScope: 'kentcdodds' }
	const manifest = parse('@kentcdodds/cursor-cloud-agents', {}, scope)
	expect(manifest.name).toBe('@kentcdodds/cursor-cloud-agents')
	expect(manifest.kody.id).toBe('cursor-cloud-agents')

	const omittedKodyId = parse(
		'@kentcdodds/cursor-cloud-agents',
		{ id: undefined },
		scope,
	)
	expect(omittedKodyId.kody.id).toBe('cursor-cloud-agents')

	// Descriptions longer than the write limit still parse (published
	// snapshots); the write path enforces the cap separately.
	const tooLongForWrite = 'a'.repeat(KODY_DESCRIPTION_MAX_LENGTH + 1)
	expect(
		parse('@kentcdodds/long-description', { description: tooLongForWrite }).kody
			.description,
	).toBe(tooLongForWrite)
	expect(() => assertKodyDescriptionLength('a'.repeat(200))).not.toThrow()
	expect(() => assertKodyDescriptionLength('a'.repeat(201))).toThrow(
		/kody\.description must be at most 200 characters/,
	)
})

test('parseAuthoredPackageJson authoring refuses package-app host reserved leaves', () => {
	expect(() => parse('@kentcdodds/packages')).toThrow(
		/reserved for package-app host paths/,
	)
	// Existing published snapshots with a reserved leaf must still load.
	expect(
		parseAuthoredPackageJson({
			content: JSON.stringify({
				name: '@kentcdodds/packages',
				private: true,
				exports: { '.': './src/index.ts' },
				kody: { description: 'legacy reserved leaf' },
			}),
			mode: 'published',
		}).kody.id,
	).toBe('packages')
})

test('parseAuthoredPackageJson rejects invalid manifests with a specific error per rule', () => {
	const discordGateway = '@kentcdodds/discord-gateway'
	type Case = [
		name: string,
		kody: Record<string, unknown>,
		error: RegExp | string,
		options?: Parameters<typeof parse>[2],
	]
	const cases: Array<Case> = [
		// Package name / scope.
		[
			'@kentcdodds/cursor-cloud-agents',
			{},
			/must use the authenticated user's package scope "@kody\/\*"/,
			{ expectedPackageScope: 'kody' },
		],
		[
			'@kentcdodds/cursor-cloud-agents',
			{ id: 'follow-up-on-pr-agent' },
			/must use a leaf package name that matches kody\.id "follow-up-on-pr-agent"/,
		],
		['cursor-cloud-agents', {}, /must be a scoped package name/],
		// kody.app.
		['@kentcdodds/bad-app', { app: { client: './src/client.ts' } }, /entry/],
		...['remix', 'fetch', 'vite'].map((runtime): Case => [
			'@kentcdodds/runtime-app',
			{ app: { runtime, entry: './src/app.ts' } },
			/kody\.app\.runtime was removed/,
		]),
		// Whitespace-only paths are rejected up front instead of trimming to an
		// empty entry that publish would then silently skip.
		...[
			{ entry: '  ' },
			{ entry: './src/app.ts', client: ' ' },
			{ entry: './src/app.ts', client: { entry: '\t' } },
			{ entry: './src/app.ts', assets: '  ' },
		].map((app): Case => ['@kentcdodds/runtime-app', { app }, /app/]),
		...['./local.ts', '/abs.js', 'kody:runtime', 'https://esm.sh/preact'].map(
			(external): Case => [
				'@kentcdodds/bad-externals',
				{
					app: {
						entry: './src/app.ts',
						client: { entry: './src/client.ts', externals: [external] },
					},
				},
				/bare package specifiers/,
			],
		),
		// Removed / unsupported extensions.
		[
			'@kentcdodds/shade-automation',
			{ workflows: { 'shade-event': { export: './run-event' } } },
			/kody\.workflows is not a supported field/,
			{ exports: { './run-event': './src/run-event.ts' } },
		],
		[
			'@kentcdodds/discord',
			{ services: { gateway: { entry: './src/services/gateway.ts' } } },
			/kody\.services is not a supported field/,
		],
		// kody.emits.
		[
			discordGateway,
			{ emits: { 'discord.message.created': discordEvent } },
			/must use the scoped form "@scope\/topic\.name"/,
		],
		[
			discordGateway,
			{ emits: { '@other/discord.message.created': discordEvent } },
			/must use the package scope "@kentcdodds"/,
		],
		[
			discordGateway,
			{
				emits: {
					'@kentcdodds/discord.message.created': {
						...discordEvent,
						payloadSchema: { type: 'string' },
					},
				},
			},
			/payloadSchema must declare "type": "object"/,
		],
		[
			discordGateway,
			{
				emits: {
					'@kentcdodds/discord.message.created': {
						...discordEvent,
						payloadSchema: {
							type: 'object',
							properties: {
								messageId: { type: 'string', pattern: '^[0-9]+$' },
							},
						},
					},
				},
			},
			/payloadSchema is not a supported JSON Schema subset/,
		],
		// kody.retrievers.
		[
			'@kentcdodds/personal-inbox',
			{
				retrievers: {
					'notes-search': {
						export: './search-notes',
						name: 'Personal notes',
						description: 'Searches saved notes and snippets.',
						scopes: [],
					},
				},
			},
			'Too small',
			{
				exports: {
					'.': './index.ts',
					'./search-notes': './src/search-notes.ts',
				},
			},
		],
		// kody.webhooks.
		[
			'@kentcdodds/sentry-bridge',
			{ webhooks: [{ name: 'sentry', export: './missing-export' }] },
			/export "\.\/missing-export"/,
		],
		[
			'@kentcdodds/sentry-bridge',
			{
				webhooks: [
					{ name: 'sentry', export: './handle-sentry-webhook' },
					{ name: 'sentry', export: './handle-sentry-webhook' },
				],
			},
			/Duplicate webhook name/,
			sentryExports,
		],
		[
			'@kentcdodds/sentry-bridge',
			sentryHook({
				verification: hmac('bad header\nname', 'sentryWebhookSecret'),
			}),
			/header/,
			sentryExports,
		],
		[
			'@kentcdodds/sentry-bridge',
			sentryHook({ rateLimitPerMinute: 601 }),
			/rateLimitPerMinute/,
			sentryExports,
		],
		[
			'@kentcdodds/raycast',
			{ webhooks: [{ name: 'star', export: '*' }] },
			/export "\*"/,
			{ exports: { './search': './src/search.ts' } },
		],
		[
			'@kentcdodds/sentry-bridge',
			sentryHook({
				replay: { timestampHeader: 'X-Timestamp', timestampFormat: 'rfc-2822' },
			}),
			/Unknown webhook replay timestampFormat "rfc-2822"/,
			sentryExports,
		],
		[
			'@kentcdodds/sentry-bridge',
			sentryHook({ challenge: { type: 'unknown-quiz', secretName: 'x' } }),
			/challenge/,
			sentryExports,
		],
		[
			'@kentcdodds/sentry-bridge',
			sentryHook({
				challenge: {
					type: 'subscription-challenge',
					method: 'GET',
					challenge: { in: 'query', key: 'crc_token' },
					prove: {
						kind: 'hmac',
						algorithm: 'hmac-sha256',
						encoding: 'base64',
					},
					respond: { as: 'json-hmac', key: 'response_token' },
				},
			}),
			/secretName/,
			sentryExports,
		],
		[
			'@kentcdodds/sentry-bridge',
			sentryHook({
				challenge: {
					type: 'subscription-challenge',
					method: 'GET',
					challenge: { in: 'query', key: 'crc_token' },
					prove: {
						kind: 'hmac',
						secretName: 'x',
						algorithm: 'hmac-sha256',
						encoding: 'base64',
					},
					respond: { as: 'text' },
				},
			}),
			/prove.kind=hmac requires respond.as=json-hmac/,
			sentryExports,
		],
		[
			'@kentcdodds/sentry-bridge',
			sentryHook({
				challenge: {
					type: 'subscription-challenge',
					method: 'POST',
					challenge: { in: 'json', key: 'challenge' },
					respond: { as: 'json', key: 'challenge' },
				},
			}),
			/when.json/,
			sentryExports,
		],
		[
			'@kentcdodds/sentry-bridge',
			sentryHook({
				challenge: {
					type: 'subscription-challenge',
					method: 'GET',
					challenge: { in: 'query', key: '__proto__' },
					respond: { as: 'text' },
				},
			}),
			/prototype property names|Challenge keys/,
			sentryExports,
		],
	]
	const unmatched = cases.filter(([name, kody, error, options]) => {
		try {
			parse(name, kody, options)
			return true
		} catch (thrown) {
			const message = thrown instanceof Error ? thrown.message : String(thrown)
			return typeof error === 'string'
				? !message.includes(error)
				: !error.test(message)
		}
	})
	expect(unmatched).toEqual([])
})

test('parseAuthoredPackageJson accepts subscriptions, emits, retrievers, and secret mounts', () => {
	const manifest = parse('@kentcdodds/discord-gateway', {
		secretMounts: {
			discordBotToken: {
				name: 'discordBotTokenKentPersonalAutomation',
				scope: 'user',
			},
		},
		secretProvider: { id: '1password' },
		subscriptions: {
			'discord.message.created': {
				handler: './src/handle-discord-message-created.ts',
				description: 'Personal-history subscriber',
				filters: { channelIds: ['1470913684598423592'] },
			},
		},
		emits: { '@kentcdodds/discord.message.created': discordEvent },
		retrievers: {
			'notes-search': {
				export: './search-notes',
				name: 'Personal notes',
				description: 'Searches saved notes and snippets.',
				scopes: ['context', 'search'],
				timeoutMs: 250,
				maxResults: 3,
			},
		},
	})

	expect(manifest.kody.secretMounts).toEqual({
		discordBotToken: {
			name: 'discordBotTokenKentPersonalAutomation',
			scope: 'user',
		},
	})
	expect(manifest.kody.secretProvider).toEqual({ id: '1password' })
	expect(manifest.kody.subscriptions).toEqual({
		'discord.message.created': {
			handler: './src/handle-discord-message-created.ts',
			description: 'Personal-history subscriber',
			filters: { channelIds: ['1470913684598423592'] },
		},
	})
	expect(manifest.kody.emits).toEqual({
		'@kentcdodds/discord.message.created': discordEvent,
	})
	expect(listPackageEmittedEvents(manifest)).toEqual([
		{
			topic: '@kentcdodds/discord.message.created',
			...discordEvent,
			payloadSchema: null,
		},
	])
	expect(buildPackageSearchProjection(manifest).retrievers).toEqual([
		{
			key: 'notes-search',
			exportName: './search-notes',
			name: 'Personal notes',
			description: 'Searches saved notes and snippets.',
			scopes: ['context', 'search'],
			timeoutMs: 250,
			maxResults: 3,
		},
	])

	const withPayloadSchema = parse('@kentcdodds/discord-gateway', {
		emits: {
			'@kentcdodds/discord.message.created': {
				...discordEvent,
				payloadSchema: messageIdSchema,
			},
		},
	})
	expect(listPackageEmittedEvents(withPayloadSchema)).toEqual([
		{
			topic: '@kentcdodds/discord.message.created',
			...discordEvent,
			payloadSchema: messageIdSchema,
		},
	])
})

test('kody.emits mcp: true opts a topic into MCP Events; false or absent does not', () => {
	const manifest = parse('@kentcdodds/discord-gateway', {
		emits: {
			'@kentcdodds/discord.message.created': {
				description: 'A Discord message was created.',
				mcp: true,
			},
			'@kentcdodds/discord.message.deleted': {
				description: 'A Discord message was deleted.',
				mcp: false,
			},
			'@kentcdodds/discord.message.updated': {
				description: 'A Discord message was updated.',
			},
		},
	})
	const emitted = listPackageEmittedEvents(manifest)
	expect(emitted).toEqual([
		{
			topic: '@kentcdodds/discord.message.created',
			description: 'A Discord message was created.',
			payloadSchema: null,
			mcp: true,
		},
		{
			topic: '@kentcdodds/discord.message.deleted',
			description: 'A Discord message was deleted.',
			payloadSchema: null,
		},
		{
			topic: '@kentcdodds/discord.message.updated',
			description: 'A Discord message was updated.',
			payloadSchema: null,
		},
	])
	expect(
		emitted.filter((event) => event.mcp).map((event) => event.topic),
	).toEqual(['@kentcdodds/discord.message.created'])
	expect(() =>
		parse('@kentcdodds/discord-gateway', {
			emits: {
				'@kentcdodds/discord.message.created': {
					description: 'A Discord message was created.',
					mcp: 'yes',
				},
			},
		}),
	).toThrow(/expected boolean[\s\S]*\.mcp/)
})

test('parseAuthoredPackageJson accepts kody.webhooks with verification, replay, challenge, and trusted rate limits', () => {
	const sentryVerification = hmac(
		'sentry-hook-signature',
		'sentryWebhookSecret',
	)
	const sentry = parse(
		'@kentcdodds/sentry-bridge',
		sentryHook({ responseMode: 'ack', verification: sentryVerification }),
		sentryExports,
	)
	expect(sentry.kody.webhooks).toEqual([
		{
			name: 'sentry',
			export: './handle-sentry-webhook',
			responseMode: 'ack',
			verification: sentryVerification,
		},
	])
	expect(buildPackageSearchProjection(sentry).webhooks).toEqual([
		{
			...webhookDefaults,
			name: 'sentry',
			exportName: './handle-sentry-webhook',
			verification: sentryVerification,
		},
	])

	const urlSecret = parse(
		'@kentcdodds/sentry-bridge',
		sentryHook({ verification: { type: 'url-secret' } }),
		sentryExports,
	)
	expect(urlSecret.kody.webhooks?.[0]?.verification).toEqual({
		type: 'url-secret',
	})
	expect(buildPackageSearchProjection(urlSecret).webhooks).toEqual([
		{
			...webhookDefaults,
			name: 'sentry',
			exportName: './handle-sentry-webhook',
			verification: { type: 'url-secret' },
		},
	])
	expect(() =>
		parse(
			'@kentcdodds/sentry-bridge',
			sentryHook({ verification: { type: 'url-secrets' } }),
			sentryExports,
		),
	).toThrow(/verification/)

	const trusted = parse(
		'@kentcdodds/discord',
		{
			webhooks: [
				{
					name: 'message-created',
					export: './dispatch-message-created',
					responseMode: 'sync',
					inputMode: 'params',
					rateLimitPerMinute: 600,
				},
			],
		},
		{
			exports: {
				'./dispatch-message-created': './src/dispatch-message-created.ts',
			},
		},
	)
	expect(buildPackageSearchProjection(trusted).webhooks).toEqual([
		{
			...webhookDefaults,
			name: 'message-created',
			exportName: './dispatch-message-created',
			responseMode: 'sync',
			inputMode: 'params',
			rateLimitPerMinute: 600,
		},
	])

	const stripeVerification = {
		...hmac('Stripe-Signature', 'stripeWebhookSecret'),
		signedPayload: 'timestamp.body',
	}
	const stripeReplay = {
		timestampHeader: 'Stripe-Signature',
		timestampFormat: 'stripe-signature',
		toleranceSeconds: 300,
	}
	const stripe = parse(
		'@kentcdodds/stripe-bridge',
		{
			webhooks: [
				{
					name: 'stripe',
					export: './handle-stripe-webhook',
					verification: stripeVerification,
					replay: stripeReplay,
				},
			],
		},
		{
			exports: { './handle-stripe-webhook': './src/handle-stripe-webhook.ts' },
		},
	)
	expect(buildPackageSearchProjection(stripe).webhooks).toEqual([
		{
			...webhookDefaults,
			name: 'stripe',
			exportName: './handle-stripe-webhook',
			verification: stripeVerification,
			replay: stripeReplay,
		},
	])

	const xVerification = {
		...hmac('X-Twitter-Webhooks-Signature', 'xConsumerSecret'),
		encoding: 'base64',
		prefix: 'sha256=',
	}
	const xChallenge = {
		type: 'subscription-challenge',
		method: 'GET',
		challenge: { in: 'query', key: 'crc_token' },
		prove: {
			kind: 'hmac',
			secretName: 'xConsumerSecret',
			algorithm: 'hmac-sha256',
			encoding: 'base64',
			prefix: 'sha256=',
		},
		respond: { as: 'json-hmac', key: 'response_token' },
	}
	const x = parse(
		'@kentcdodds/x',
		{
			webhooks: [
				{
					name: 'activity-event',
					export: './activity-event',
					challenge: xChallenge,
					verification: xVerification,
				},
			],
		},
		{ exports: { './activity-event': './src/activity-event.ts' } },
	)
	expect(buildPackageSearchProjection(x).webhooks).toEqual([
		{
			...webhookDefaults,
			name: 'activity-event',
			exportName: './activity-event',
			verification: xVerification,
			challenge: xChallenge,
		},
	])

	const hubChallenge = {
		type: 'subscription-challenge',
		method: 'GET',
		challenge: { in: 'query', key: 'hub.challenge' },
		when: { query: { 'hub.mode': 'subscribe' } },
		prove: {
			kind: 'verify-token',
			in: 'query',
			key: 'hub.verify_token',
			secretName: 'hubVerify',
		},
		respond: { as: 'json', key: 'hub.challenge' },
	} as const
	const hub = parse(
		'@kentcdodds/activity-hub',
		{
			webhooks: [
				{
					name: 'events',
					export: './handle-events',
					challenge: hubChallenge,
				},
			],
		},
		{ exports: { './handle-events': './src/handle-events.ts' } },
	)
	expect(buildPackageSearchProjection(hub).webhooks).toEqual([
		{
			...webhookDefaults,
			name: 'events',
			exportName: './handle-events',
			challenge: hubChallenge,
		},
	])
})

test('buildPackageSearchProjection extracts export metadata, referenced types, and search documents', () => {
	const weatherProjection = buildPackageSearchProjection(
		parse(
			'@kentcdodds/weather-tools',
			{},
			{
				exports: {
					'.': { import: './src/index.ts', types: './src/index.d.ts' },
				},
			},
		),
		{
			'src/index.ts':
				'export const ignored = "types file should be preferred for metadata"',
			'src/index.d.ts': `/**
 * Look up the forecast for a city.
 */
export declare function forecast(city: string): Promise<string>

/**
 * Convert Celsius to Fahrenheit.
 */
export declare const celsiusToFahrenheit: (value: number) => number
`,
		},
	)

	expect(weatherProjection.exports).toEqual([
		expect.objectContaining({
			subpath: '.',
			runtimeTarget: 'src/index.ts',
			typesPath: 'src/index.d.ts',
			description: 'Look up the forecast for a city.',
			functions: [
				{
					name: 'forecast',
					description: 'Look up the forecast for a city.',
					typeDefinition:
						'export declare function forecast(city: string): Promise<string>',
					referencedTypes: [],
				},
				{
					name: 'celsiusToFahrenheit',
					description: 'Convert Celsius to Fahrenheit.',
					typeDefinition:
						'export declare const celsiusToFahrenheit: (value: number) => number',
					referencedTypes: [],
				},
			],
			referencedTypes: [],
		}),
	])

	const cursorProjection = buildPackageSearchProjection(
		parse(
			'@kentcdodds/cursor-cloud-agents',
			{},
			{
				exports: {
					'./launch-cursor-cloud-agent': {
						import: './src/launch-cursor-cloud-agent.ts',
						types: './src/launch-cursor-cloud-agent.d.ts',
					},
				},
			},
		),
		{
			'src/launch-cursor-cloud-agent.d.ts': `type LaunchCursorCloudAgentInput = {
	prompt: string
	repository: RepositoryTarget
	mode?: LaunchMode
	metadata?: Record<string, string>
	createdAt?: Date
}

interface RepositoryTarget {
	owner: string
	repo: string
}

enum LaunchMode {
	Background = 'background',
	Interactive = 'interactive',
}

type UnrelatedLocalType = {
	ignored: boolean
}

/**
 * Launch a Cursor Cloud agent.
 */
export declare function launch(input: LaunchCursorCloudAgentInput): Promise<Response>
`,
		},
	)

	const [exportDetail] = cursorProjection.exports
	expect(exportDetail).toMatchObject({
		subpath: './launch-cursor-cloud-agent',
		functions: [
			expect.objectContaining({
				name: 'launch',
				description: 'Launch a Cursor Cloud agent.',
				typeDefinition:
					'export declare function launch(input: LaunchCursorCloudAgentInput): Promise<Response>',
			}),
		],
	})
	expect(
		exportDetail?.referencedTypes.map((type) => [type.name, type.kind]),
	).toEqual([
		['LaunchCursorCloudAgentInput', 'type'],
		['RepositoryTarget', 'interface'],
		['LaunchMode', 'enum'],
	])
	expect(
		exportDetail?.referencedTypes.every((type) => type.definition.length > 0),
	).toBe(true)
	expect(exportDetail?.functions[0]?.referencedTypes).toEqual(
		exportDetail?.referencedTypes,
	)
	const referencedTypeText = exportDetail?.referencedTypes
		.map((type) => type.definition)
		.join('\n')
	for (const excluded of [
		'UnrelatedLocalType',
		'type Record',
		'type Date',
		'interface Response',
	]) {
		expect(referencedTypeText).not.toContain(excluded)
	}

	const mixedProjection = buildPackageSearchProjection(
		parse(
			'@kentcdodds/mixed-runtime-tools',
			{},
			{
				exports: { '.': './src/index.ts' },
			},
		),
		{
			'src/index.ts': `type GenericBound = {
	value: string
}

type RenderedInput = {
	value: string
}

/**
 * Package version metadata.
 */
export declare const VERSION: string

export declare const typed: (value: string) => string

export declare const typedGeneric: <T extends RenderedInput>(input: T) => string

/**
 * Runtime formatter.
 */
export const format = (value: string): string => value.trim()

export const genericFormat = <T extends GenericBound>(input: T): string => input.value
`,
		},
	)

	expect(mixedProjection.exports[0]?.functions.map((fn) => fn.name)).toEqual([
		'typed',
		'typedGeneric',
		'format',
		'genericFormat',
	])
	expect(
		mixedProjection.exports[0]?.functions
			.find((fn) => fn.name === 'typedGeneric')
			?.referencedTypes.map((type) => type.name),
	).toEqual(['RenderedInput'])
	expect(
		mixedProjection.exports[0]?.referencedTypes.map((type) => type.name),
	).toEqual(['RenderedInput'])

	const oversizedFields = Array.from(
		{ length: 1_500 },
		(_, index) => `	field${index}: string`,
	).join('\n')
	const largeProjection = buildPackageSearchProjection(
		parse(
			'@kentcdodds/large-type-tools',
			{},
			{
				exports: { '.': './src/index.ts' },
			},
		),
		{
			'src/index.ts': `type HugeInput = {
${oversizedFields}
}

type SmallInput = {
	value: string
}

export function run(huge: HugeInput, small: SmallInput): string {
	return small.value
}
`,
		},
	)
	expect(
		largeProjection.exports[0]?.referencedTypes.map((type) => type.name),
	).toEqual(['SmallInput'])
	expect(
		largeProjection.exports[0]?.referencedTypes.every(
			(type) => type.definition.length > 0,
		),
	).toBe(true)

	const emailProjection = buildPackageSearchProjection(
		parse('@kentcdodds/email-notifier', {
			subscriptions: {
				'email.message.received': {
					handler: './src/handle-received-email.ts',
					description: 'Notify on accepted inbound email',
					filters: { policy_decisions: ['accepted'] },
				},
				'email.message.quarantined': {
					handler: './src/handle-quarantined-email.ts',
				},
			},
		}),
	)
	expect(emailProjection.subscriptions).toEqual([
		{
			topic: 'email.message.quarantined',
			handler: 'src/handle-quarantined-email.ts',
			description: null,
			filters: null,
		},
		{
			topic: 'email.message.received',
			handler: 'src/handle-received-email.ts',
			description: 'Notify on accepted inbound email',
			filters: { policy_decisions: ['accepted'] },
		},
	])
})

test('buildPackageSearchProjection follows local default-export bindings and one-hop imported types', () => {
	const project = (files: Record<string, string>, subpath = '.') =>
		buildPackageSearchProjection(
			parse(
				'@kentcdodds/default-export-tools',
				{},
				{
					exports: {
						[subpath]: `./src/${subpath === '.' ? 'index' : subpath.slice(2)}.ts`,
					},
				},
			),
			files,
		).exports[0]

	const spotifyExport = project(
		{
			'src/search.ts': `import type { SearchParams } from '../lib/export-types.ts'
import { searchCatalog } from '../lib/search-catalog.ts'

/**
 * Search the Spotify catalog.
 */
async function spotifySearch(params: SearchParams = {}) {
	return await searchCatalog(params)
}

export default spotifySearch
`,
			'lib/export-types.ts': `import type { PagingParams } from './paging.ts'

export type SearchParams = {
	q?: string
	types?: Array<'album' | 'artist' | 'track'>
	limit?: number
	paging?: PagingParams
}

export type UnrelatedExportType = {
	ignored: boolean
}
`,
			'lib/paging.ts': `export type PagingParams = {
	offset?: number
}
`,
			'lib/search-catalog.ts': `export async function searchCatalog(params: { q?: string }) {
	return params
}
`,
		},
		'./search',
	)
	expect(spotifyExport?.functions.map((fn) => fn.name)).toEqual(['default'])
	expect(spotifyExport?.typeDefinition).toContain('spotifySearch')
	// One hop only: PagingParams and UnrelatedExportType are excluded.
	expect(spotifyExport?.referencedTypes.map((type) => type.name)).toEqual([
		'SearchParams',
	])
	expect(spotifyExport?.referencedTypes[0]?.kind).toBe('type')
	expect(spotifyExport?.referencedTypes[0]?.definition).toContain('q?: string')

	const arrowDefaultExport = project({
		'src/index.ts': `import type { SearchParams } from '../lib/export-types.ts'

/**
 * Search with a local arrow binding.
 */
const search = async (params: SearchParams = {}) => params

export default search
`,
		'lib/export-types.ts': `export type SearchParams = {
	q?: string
}
`,
	})
	expect(arrowDefaultExport?.functions[0]?.name).toBe('default')
	expect(arrowDefaultExport?.referencedTypes.map((type) => type.name)).toEqual([
		'SearchParams',
	])

	const jsDocFallbackExport = project({
		'src/index.ts': `async function search(query: string) {
	return query
}

/**
 * Docs live on the export default line.
 */
export default search
`,
	})
	expect(jsDocFallbackExport?.typeDefinition).toContain('search(query: string)')
	expect(jsDocFallbackExport?.description).toBeTruthy()

	expect(
		project({
			'src/index.ts': `import foo from './other.ts'

/**
 * Should not be attributed to an imported re-export.
 */
export default foo
`,
			'src/other.ts': `/**
 * Implemented in another module.
 */
export default async function foo(params: { q: string }) {
	return params
}
`,
		}),
	).toMatchObject({
		description: null,
		typeDefinition: null,
		functions: [],
		referencedTypes: [],
	})

	expect(
		project({
			'src/index.ts': `/**
 * Look up a city forecast.
 */
export async function forecast(city: string): Promise<string> {
	return city
}

export default forecast
`,
		})?.functions,
	).toEqual([expect.objectContaining({ name: 'forecast' })])
})
