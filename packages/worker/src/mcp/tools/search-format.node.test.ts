import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { Script, createContext } from 'node:vm'
import { expect, test } from 'vitest'
import { McpCallerError } from '#mcp/caller-error.ts'
import {
	compactCapabilityInputTypeDefinition,
	formatEntityDetailMarkdown,
	formatSearchMarkdown,
	inlineCapabilityInputTypeMaxLength,
	parseEntityRef,
	toSlimStructuredMatches,
} from './search-format.ts'
import {
	type SearchEntityDetail,
	type SearchMatch,
	type SlimSearchMatch,
} from './search-format-types.ts'

type PackageDetail = Extract<SearchEntityDetail, { type: 'package' }>
type CapabilitySpecInput = Extract<
	SearchEntityDetail,
	{ type: 'capability' }
>['spec']
type PackageMatch = Extract<SearchMatch, { type: 'package' }>
type IntegrationMatch = Extract<SearchMatch, { type: 'integration' }>

function executeUsageSnippet(usage: string) {
	const calls: Array<{ toolName: string; args: unknown }> = []
	const kody = {
		integrationGet(args: unknown) {
			calls.push({
				toolName: 'integrationGet',
				args: JSON.parse(JSON.stringify(args)),
			})
		},
	}
	new Script(usage).runInContext(createContext({ kody }))
	return calls
}

function usageOf(match: SlimSearchMatch | undefined) {
	if (!match || !('usage' in match)) {
		throw new Error('Expected slim match with usage')
	}
	return match.usage
}

function capabilityDetail(
	spec: Partial<CapabilitySpecInput> &
		Pick<
			CapabilitySpecInput,
			'name' | 'domain' | 'description' | 'inputTypeDefinition'
		>,
	extra: { relatedOperationCount?: number } = {},
) {
	return formatEntityDetailMarkdown({
		type: 'capability',
		id: spec.name,
		title: spec.name,
		description: spec.description,
		spec: {
			keywords: [],
			readOnly: true,
			idempotent: true,
			destructive: false,
			orgPermission: 'none',
			source: 'builtin',
			inputFields: [],
			requiredInputFields: [],
			outputFields: [],
			inputSchema: { type: 'object', properties: {} },
			...spec,
		},
		...extra,
	})
}

function packageDetail(input: {
	kodyId: string
	name: string
	description: string
	recordId: string
	hasApp?: boolean
	hostedUrl?: string | null
	listingAhead?: boolean | null
	exports?: PackageDetail['manifest']['exports']
	kody?: Partial<PackageDetail['manifest']['kody']>
	files?: Record<string, string>
}) {
	const { kodyId, name, description } = input
	return formatEntityDetailMarkdown({
		type: 'package',
		id: kodyId,
		title: name,
		description,
		baseUrl: 'http://localhost',
		ownerUsername: 'test-user',
		hostedUrl: input.hostedUrl ?? null,
		listingAhead: input.listingAhead ?? null,
		record: {
			id: input.recordId,
			userId: ownerIdFromStored('user-1'),
			name,
			kodyId,
			description,
			tags: [],
			searchText: null,
			sourceId: `source-${input.recordId}`,
			hasApp: input.hasApp ?? false,
			hasSkills: false,
			hidden: false,
			isPrivate: false,
			isInternetVisible: false,
			lockedAt: null,
			createdAt: '2026-03-20T00:00:00.000Z',
			updatedAt: '2026-03-20T00:00:00.000Z',
		},
		manifest: {
			name,
			exports: input.exports ?? { '.': './index.ts' },
			kody: { id: kodyId, description, ...input.kody },
		},
		files: { 'package.json': '{}', ...input.files },
	})
}

function packageMatch(
	overrides: Partial<PackageMatch> & Pick<PackageMatch, 'kodyId' | 'name'>,
): PackageMatch {
	return {
		type: 'package',
		packageId: `package-${overrides.kodyId}`,
		title: overrides.name,
		description: `${overrides.kodyId} package.`,
		tags: [],
		hasApp: false,
		hidden: false,
		...overrides,
	}
}

function integrationMatch(
	name: string,
	overrides: Partial<IntegrationMatch> = {},
): IntegrationMatch {
	return {
		type: 'integration',
		integrationName: name,
		title: name,
		description: `${name} OAuth integration config`,
		flow: 'confidential',
		tokenUrl: 'https://example.com/token',
		apiBaseUrl: 'https://example.com/api',
		requiredHosts: ['example.com'],
		clientId: `${name}-client-id`,
		...overrides,
	}
}

const slim = (matches: Array<SearchMatch>, username?: string) =>
	toSlimStructuredMatches({ baseUrl: 'http://localhost', username, matches })

const listMarkdown = (matches: Array<SearchMatch>) =>
	formatSearchMarkdown({ matches, includePreamble: false })

const nextStepOf = (match: ReturnType<typeof slim>[number] | undefined) =>
	match && 'nextStep' in match ? match.nextStep : ''

test('search formatting keeps entity refs and generates safe, runnable usage snippets', () => {
	const parsed: Array<[string, ReturnType<typeof parseEntityRef>]> = [
		['integration:github', { id: 'github', type: 'integration' }],
		['mcp-server:home', { id: 'home', type: 'mcp-server' }],
		['guide:package_authoring', { id: 'package_authoring', type: 'guide' }],
		[
			'guide:package_subscriptions#repo.pushed',
			{ id: 'package_subscriptions', type: 'guide', section: 'repo.pushed' },
		],
		[
			'guide:package_authoring#L165',
			{ id: 'package_authoring', type: 'guide', section: 'L165' },
		],
		[
			'guide:package_authoring#L165-L180',
			{ id: 'package_authoring', type: 'guide', section: 'L165-L180' },
		],
		[
			'package:home-controls#src/index.ts#L165',
			{ id: 'home-controls', type: 'package', section: 'src/index.ts#L165' },
		],
		[
			'package:home-controls#README.md#export-jsdoc',
			{
				id: 'home-controls',
				type: 'package',
				section: 'README.md#export-jsdoc',
			},
		],
		[
			'package:home-controls#bond-area-shades',
			{ id: 'home-controls', type: 'package', section: 'bond-area-shades' },
		],
		[
			'package:home-controls#./bond-area-shades',
			{ id: 'home-controls', type: 'package', section: './bond-area-shades' },
		],
		[
			'package:cpp-tools#./c++',
			{ id: 'cpp-tools', type: 'package', section: './c++' },
		],
		[
			'guide:topic#hello%20world',
			{ id: 'topic', type: 'guide', section: 'hello world' },
		],
		[
			'capability:mcp:home:set_pin',
			{ id: 'mcp:home:set_pin', type: 'capability' },
		],
		['mcp-server:mcp:home', { id: 'mcp:home', type: 'mcp-server' }],
	]
	expect(parsed.map(([ref]) => [ref, parseEntityRef(ref)])).toEqual(parsed)

	const rejected: Array<[string, RegExp]> = [
		['not-an-entity-ref', /Entity must use the format/],
		[':capability', /Entity must use the format/],
		['id:', /Entity must use the format/],
		['foo:bar', /Entity type must be one of/],
		['user:preferred_repo:value', /Entity type must be one of/],
		['guide:package_subscriptions#', /Section fragment/],
		['home-controls:package', /Entity type must be one of/],
		['home-controls:package#bond-area-shades', /Entity type must be one of/],
		['mcp:home:set_pin:capability', /Entity type must be one of/],
		['home:mcp-server', /Entity type must be one of/],
	]
	for (const [ref, message] of rejected) {
		expect(() => parseEntityRef(ref)).toThrow(McpCallerError)
		expect(() => parseEntityRef(ref)).toThrow(message)
	}

	const structuredMatches = slim([
		integrationMatch('github', {
			description: 'GitHub OAuth integration config',
			tokenUrl: 'https://github.com/login/oauth/access_token',
			apiBaseUrl: 'https://api.github.com',
			clientId: 'github_client_id',
			requiredHosts: ['api.github.com'],
			authorization: {
				authorizeUrl: 'https://github.com/login/oauth/authorize',
				scopes: ['repo', 'read:user'],
				scopeSeparator: null,
				extraAuthorizeParams: { prompt: 'consent' },
			},
		}),
		integrationMatch('conn"name'),
		{
			type: 'secret',
			name: 'secret "name"',
			description: 'Secret with a display name that is not placeholder-safe.',
		},
	])
	expect(structuredMatches[0]).toMatchObject({
		type: 'integration',
		entityRef: 'integration:github',
		flow: 'confidential',
		tokenUrl: 'https://github.com/login/oauth/access_token',
		requiredHosts: ['api.github.com'],
		authorization: {
			authorizeUrl: 'https://github.com/login/oauth/authorize',
			scopes: ['repo', 'read:user'],
		},
	})
	expect(executeUsageSnippet(usageOf(structuredMatches[1]))).toEqual([
		{ toolName: 'integrationGet', args: { name: 'conn"name' } },
	])
	expect(structuredMatches[2]).toMatchObject({
		type: 'secret',
		id: 'secret "name"',
		entityRef: 'secret:secret "name"',
	})
	expect(usageOf(structuredMatches[2])).not.toContain('{{secret:')

	const githubConfig = {
		name: 'github',
		tokenUrl: 'https://github.com/login/oauth/access_token',
		apiBaseUrl: 'https://api.github.com',
		flow: 'confidential' as const,
		clientId: 'github_client_id',
		requiredHosts: ['api.github.com'],
		authorization: null,
	}
	const integrationDetail = formatEntityDetailMarkdown({
		type: 'integration',
		id: 'github',
		title: 'github',
		description: 'GitHub OAuth integration config',
		config: githubConfig,
		relatedPackageSuggestions: [
			{
				source: 'user',
				kodyId: 'github',
				name: '@user/github',
				description: 'User GitHub package.',
				entityRef: 'package:github',
			},
			{
				source: 'community',
				kodyId: 'github-helpers',
				name: '@kody/github-helpers',
				description: 'Trusted community GitHub helpers.',
				listingId: 'listing-1',
				publicUrl: 'https://example.com/@kody/github-helpers',
				trusted: true,
			},
		],
	})
	expect(integrationDetail.structured).toMatchObject({
		type: 'integration',
		entityRef: 'integration:github',
		clientId: 'github_client_id',
		relatedPackageSuggestions: [
			expect.objectContaining({ source: 'user', entityRef: 'package:github' }),
			expect.objectContaining({
				source: 'community',
				listingId: 'listing-1',
				trusted: true,
			}),
		],
	})
	expect(integrationDetail.markdown).toContain('package:github')
	expect(integrationDetail.markdown).toContain('listing-1')
	expect(integrationDetail.markdown).toContain('Client ID: `github_client_id`')
	// Structured contract omits soak token secret names (input still carries them).
	expect(integrationDetail.structured).not.toHaveProperty(
		'accessTokenSecretName',
	)
	expect(integrationDetail.structured).not.toHaveProperty(
		'clientSecretSecretName',
	)

	const leanIntegrationDetail = formatEntityDetailMarkdown({
		type: 'integration',
		id: 'github',
		title: 'github',
		description: 'GitHub OAuth integration config',
		config: githubConfig,
	})
	expect(leanIntegrationDetail.structured).not.toHaveProperty(
		'relatedPackageSuggestions',
	)
	expect(leanIntegrationDetail.markdown).not.toContain('package:github')
	expect(leanIntegrationDetail.markdown).not.toContain('listing-1')
})

test('package entity detail is a slim index with explicit follow-up, webhook challenges, and agent docs', () => {
	const observedPackageDetail = packageDetail({
		kodyId: 'observed-package',
		name: '@kody/observed-package',
		description: 'Observed package with an app surface.',
		recordId: 'package-123',
		hasApp: true,
		hostedUrl: 'http://localhost/@test-user/packages/observed-package',
		exports: {
			'.': './src/index.ts',
			'./app': { import: './src/app.ts', types: './src/app.d.ts' },
		},
		kody: {
			tags: ['observed', 'ui'],
			app: { entry: './src/app.ts' },
			jobs: {
				nightly: {
					entry: './src/jobs/nightly.ts',
					schedule: { type: 'interval', every: '1d' },
				},
			},
		},
		files: {
			'README.md':
				'# Observed package\n\n## Intent\n\nUse this package to inspect observed UI state.\n\n## Usage\n\n- Open the app for quick checks.\n',
			'src/app.d.ts':
				'/**\n * Render the observed app.\n */\nexport declare function fetch(request: Request): Promise<Response>\n',
		},
	})
	expect(observedPackageDetail.structured).toMatchObject({
		type: 'package',
		entityRef: 'package:observed-package',
		detailMode: 'index',
		hasApp: true,
		hidden: false,
		hostedUrl: 'http://localhost/@test-user/packages/observed-package',
		appEntry: './src/app.ts',
		exports: [
			{ subpath: '.', description: null },
			{ subpath: './app', description: 'Render the observed app.' },
		],
		jobs: [{ name: 'nightly' }],
		readmeIntent: {
			path: 'README.md',
			content: 'Use this package to inspect observed UI state.',
			truncated: false,
		},
		listingAhead: null,
		followUp: expect.stringContaining(
			'repoOpenSession({ target: { kind: "package", package_id: "package-123" } })',
		),
	})
	expect(observedPackageDetail.markdown).toContain('## Follow up')
	expect(observedPackageDetail.markdown).toContain(
		'Open one export with search({ entity: "package:observed-package#<subpath>" })',
	)
	expect(observedPackageDetail.structured).not.toHaveProperty('typeDefinition')
	expect(observedPackageDetail.structured).not.toHaveProperty('referencedTypes')

	const webhookDetail = packageDetail({
		kodyId: 'x-bridge',
		name: '@kody/x-bridge',
		description: 'Receives X activity events.',
		recordId: 'package-x',
		exports: {
			'.': './src/index.ts',
			'./activity': './src/activity.ts',
			'./plain': './src/plain.ts',
		},
		kody: {
			webhooks: [
				{
					name: 'activity',
					export: './activity',
					challenge: {
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
					},
				},
				{ name: 'plain', export: './plain' },
			],
		},
	})
	expect(webhookDetail.structured).toMatchObject({
		webhooks: [
			{
				name: 'activity',
				challenge: {
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
				},
			},
			{ name: 'plain', challenge: null },
		],
	})
	expect(webhookDetail.markdown).toContain('challenge subscription-challenge')
	expect(webhookDetail.markdown).not.toContain('xConsumerSecret')

	const notesDetail = packageDetail({
		kodyId: 'notes-helper',
		name: '@user/notes-helper',
		description: 'Notes helper package.',
		recordId: 'package-notes',
		kody: {
			subscriptions: { 'repo.pushed': { handler: './on-repo-pushed.ts' } },
		},
		files: {
			'README.md':
				'# Notes helper\n\n## Intent\n\nKeep notes workflows safe and reusable.\n\n## Usage\n\nFull usage details.',
			'AGENTS.md':
				'# Agents\n\nImport `kody:@user/notes-helper` and call the root export.',
			'index.ts':
				'/** Save a note. */\nexport default function main(input: { text: string }) { return input.text }',
			'on-repo-pushed.ts': 'export default function handler() {}',
		},
	})
	expect(notesDetail.markdown).toContain('## Index')
	expect(notesDetail.markdown).toContain('| Subpath | Purpose |')
	expect(notesDetail.markdown).toContain('## README Intent')
	expect(notesDetail.markdown).toContain(
		'Keep notes workflows safe and reusable.',
	)
	expect(notesDetail.markdown).not.toContain('Full usage details.')
	expect(notesDetail.markdown).toContain('## Agent docs')
	expect(notesDetail.markdown).toContain(
		'Import `kody:@user/notes-helper` and call the root export.',
	)
	expect(notesDetail.structured).toMatchObject({
		type: 'package',
		exports: [{ subpath: '.', description: 'Save a note.' }],
		readmeIntent: {
			path: 'README.md',
			content: 'Keep notes workflows safe and reusable.',
			truncated: false,
		},
		agentsDocs: {
			path: 'AGENTS.md',
			content:
				'# Agents\n\nImport `kody:@user/notes-helper` and call the root export.',
			truncated: false,
		},
	})
})

test('package search surfaces listing ahead only when the fork is behind', () => {
	const triage = { kodyId: 'github-triage', name: '@me/github-triage' }
	const [currentMatch] = slim([packageMatch(triage)], 'test-user')
	expect(currentMatch).not.toHaveProperty('listingAhead')
	expect(nextStepOf(currentMatch)).not.toMatch(/ahead/i)
	expect(nextStepOf(currentMatch)).not.toContain('repoPublishSession')

	const [aheadMatch] = slim(
		[packageMatch({ ...triage, listingAhead: true })],
		'test-user',
	)
	expect(aheadMatch).toMatchObject({ type: 'package', listingAhead: true })
	expect(nextStepOf(aheadMatch)).toContain('repoPublishSession')
	expect(nextStepOf(aheadMatch)).toContain('absorbed_upstream_commit')

	const triageDetail = (listingAhead: boolean) =>
		packageDetail({
			...triage,
			description: 'Triage GitHub issues.',
			recordId: `package-${String(listingAhead)}`,
			listingAhead,
			files: {
				'README.md': '# GitHub triage\n\n## Intent\n\nTriage issues.\n',
			},
		})
	const aheadDetail = triageDetail(true)
	expect(aheadDetail.structured).toMatchObject({ listingAhead: true })
	expect(aheadDetail.markdown).toContain('repoPublishSession')
	expect(aheadDetail.markdown).toContain('absorbed_upstream_commit')

	const forkAheadDetail = triageDetail(false)
	expect(forkAheadDetail.markdown).not.toContain('Listing ahead')
	expect(forkAheadDetail.markdown).not.toMatch(/fork ahead/i)
	expect(forkAheadDetail.markdown).not.toContain('repoPublishSession')
	expect(forkAheadDetail.structured).not.toMatchObject({ listingAhead: true })
})

test('package search formatting keeps runnable actions and hosted URLs in structured output', () => {
	const spotify = packageMatch({
		kodyId: 'spotify-playback',
		name: '@kody/spotify-playback',
		hasApp: true,
		readmeSnippet: {
			path: 'README.md',
			snippet: 'Playback controls for the hosted remote.',
			truncated: false,
		},
	})
	expect(slim([spotify], 'test-user')[0]).toMatchObject({
		type: 'package',
		id: 'spotify-playback',
		entityRef: 'package:spotify-playback',
		hasApp: true,
		hidden: false,
		hostedUrl: 'http://localhost/@test-user/packages/spotify-playback',
	})
	expect(slim([{ ...spotify, readmeSnippet: null }])[0]).toMatchObject({
		type: 'package',
		hasApp: true,
		hidden: false,
		hostedUrl: null,
	})

	const namedActionPackage = packageMatch({
		kodyId: 'google-products',
		name: '@kentcdodds/google-products',
		hasApp: true,
		actionMatches: [
			{
				subpath: './calendar',
				description: 'Create a calendar event.',
				typeDefinition:
					'export declare function createEvent(params: CalendarEventMutationParams): Promise<JsonObject>',
				functions: [
					{
						name: 'createEvent',
						description: 'Create a calendar event.',
						typeDefinition: null,
					},
				],
				score: 0.92,
				matchedTerms: ['calendar', 'create', 'event'],
			},
		],
	})
	expect(slim([namedActionPackage], 'test-user')[0]).toMatchObject({
		type: 'package',
		actionMatches: [
			expect.objectContaining({
				subpath: './calendar',
				importSpecifier: 'kody:@kentcdodds/google-products/calendar',
				functions: [expect.objectContaining({ name: 'createEvent' })],
			}),
		],
	})
	expect(listMarkdown([namedActionPackage])).toContain(
		'import { createEvent } from "kody:@kentcdodds/google-products/calendar"',
	)

	const exportHitPackage = {
		...namedActionPackage,
		title: '@kentcdodds/google-products createEvent',
		exportSubpath: './calendar',
	}
	expect(slim([exportHitPackage], 'test-user')[0]).toMatchObject({
		type: 'package',
		id: 'google-products#./calendar',
		entityRef: 'package:google-products#./calendar',
		exportSubpath: './calendar',
	})
	const exportHitMarkdown = listMarkdown([exportHitPackage])
	expect(exportHitMarkdown).toContain(
		'Entity: `package:google-products#./calendar`',
	)
	expect(exportHitMarkdown).toContain('export `./calendar`')

	const defaultAction = (kodyId: string, subpath: string, name: string) =>
		packageMatch({
			kodyId,
			name: `@kentcdodds/${kodyId}`,
			actionMatches: [
				{
					subpath,
					description: 'Move shades.',
					typeDefinition: null,
					functions: [
						{ name, description: 'Move shades.', typeDefinition: null },
					],
					score: 0.9,
					matchedTerms: ['shade'],
				},
			],
		})
	const defaultActionMarkdown = listMarkdown([
		defaultAction('shade-automation', './control', 'default'),
		defaultAction('home-controls', './bond-area-shades', 'home'),
	])
	expect(defaultActionMarkdown).toContain(
		'import action from "kody:@kentcdodds/shade-automation/control"',
	)
	expect(defaultActionMarkdown).toContain(
		'import action from "kody:@kentcdodds/home-controls/bond-area-shades"',
	)
})

test('integration search hits surface reconnect nextStep when last auth failure is yours', () => {
	const lastAuthFailure = {
		reason: 'provider_rejected',
		occurredAt: '2026-09-01T00:00:00.000Z',
		reconnectable: true,
		providerError: 'invalid_grant',
		providerErrorDescription: 'Token has been expired or revoked.',
		httpStatus: 400,
		title: 'Google · kent@gmail.com stopped working',
		why: 'The provider rejected the saved sign-in (invalid_grant: Token has been expired or revoked.).',
		who: 'you',
		doLabel: 'Reconnect',
		reconnectHref: '/connect/oauth?provider=google&loginHint=kent%40gmail.com',
		accountHref: '/account/integrations/google',
	} as const
	const [match] = slim([integrationMatch('google', { lastAuthFailure })])
	expect(match).toMatchObject({ type: 'integration' })
	expect(nextStepOf(match)).toContain('invalid_grant')
	expect(nextStepOf(match)).toContain(
		'/connect/oauth?provider=google&loginHint=kent%40gmail.com',
	)
	expect(
		formatSearchMarkdown({
			matches: [
				integrationMatch('google', {
					lastAuthFailure: {
						...lastAuthFailure,
						providerErrorDescription: null,
						reconnectHref: '/connect/oauth?provider=google',
					},
				}),
			],
		}),
	).toContain('Reconnect at `/connect/oauth?provider=google`')
})

test('search markdown summarizes broad results safely and only suggests entity detail for entity-backed hits', () => {
	const truncatedReadmeSnippet =
		'Includes setup instructions, export examples, and maintenance notes.'
	const markdown = formatSearchMarkdown({
		warnings: ['Saved package metadata warning with long details.'],
		matches: [
			packageMatch({
				kodyId: 'observed-package',
				name: '@kody/observed-package',
				readmeSnippet: {
					path: 'README.md',
					snippet: truncatedReadmeSnippet,
					truncated: true,
				},
			}),
			integrationMatch('github', {
				tokenUrl: 'https://github.com/login/oauth/access_token',
			}),
		],
	})
	for (const sensitiveValue of [
		truncatedReadmeSnippet,
		'https://github.com/login/oauth/access_token',
		'github-access-token',
		'github-refresh-token',
	]) {
		expect(markdown).not.toContain(sensitiveValue)
	}

	expect(
		slim([
			{
				type: 'capability',
				name: 'search_docs',
				description: 'Search docs capability',
				domain: 'meta',
			},
		])[0],
	).toMatchObject({ type: 'capability', entityRef: 'capability:search_docs' })
})

test('domain overview and capability list items format compact scoping hints', () => {
	const domainMatches = [
		{
			type: 'domain' as const,
			name: 'email',
			title: 'email',
			description: 'Email primitives for the per-user inbox.',
			capabilityCount: 9,
			sampleCapabilities: ['emailSend', 'emailMessageList', 'emailMessageGet'],
		},
	]
	const [domainSlim] = slim(domainMatches)
	expect(domainSlim).toMatchObject({
		type: 'domain',
		id: 'email',
		name: 'email',
		capabilityCount: 9,
		sampleCapabilities: ['emailSend', 'emailMessageList', 'emailMessageGet'],
	})
	expect(usageOf(domainSlim)).toContain('domain: "email"')

	const emailSend = {
		type: 'capability' as const,
		name: 'emailSend',
		description: 'Send a message.',
		domain: 'email',
	}
	expect(slim([emailSend])[0]).toMatchObject({
		type: 'capability',
		id: 'emailSend',
		domain: 'email',
		apiAvailable: true,
	})

	const executeOnly = {
		type: 'capability' as const,
		name: 'webhookSyntheticDispatch',
		description: 'Smoke-test a minted webhook.',
		domain: 'webhooks',
	}
	expect(slim([executeOnly])[0]).toMatchObject({
		type: 'capability',
		apiAvailable: false,
	})
})

test('search formatting inlines top capability call shapes, related ops, and MCP server summaries', () => {
	const longInputType = `type LongInput = {\n\t${'field: string\n\t'.repeat(40)}}`
	const compact = compactCapabilityInputTypeDefinition(longInputType)
	expect(compact.truncated).toBe(true)
	expect(compact.definition.length).toBeLessThanOrEqual(
		inlineCapabilityInputTypeMaxLength,
	)
	expect(compact.definition.endsWith('...')).toBe(true)
	const requiredFieldAtEnd = compactCapabilityInputTypeDefinition(
		`type LongMemoryInput = { ${Array.from(
			{ length: 40 },
			(_, index) => `optional_field_${index}?: string`,
		).join('; ')}; verified_by_agent: true }`,
		{ requiredInputFields: ['verified_by_agent'] },
	)
	expect(requiredFieldAtEnd.truncated).toBe(true)
	expect(requiredFieldAtEnd.definition.length).toBeLessThanOrEqual(
		inlineCapabilityInputTypeMaxLength,
	)
	expect(requiredFieldAtEnd.definition).toContain(
		'required fields: verified_by_agent',
	)

	const homeServer = {
		type: 'mcp-server' as const,
		id: 'home',
		title: 'home',
		description:
			'Control lights, locks, and the island router PIN on the home LAN.',
		domain: 'mcp:home',
		source: 'mcp-server' as const,
		kodyName: 'home',
		serverName: 'home',
		serverId: 'server-home',
		instructions:
			'Control lights, locks, and the island router PIN on the home LAN.',
		capabilityCount: 168,
		sampleCapabilities: ['mcp:home:set_pin'],
		usage: 'kody.mcp["home"].tool_name(args)',
		wrappingPackage: null,
	}
	expect(slim([homeServer])[0]).toMatchObject({
		type: 'mcp-server',
		entityRef: 'mcp-server:home',
		capabilityCount: 168,
		instructions:
			'Control lights, locks, and the island router PIN on the home LAN.',
	})

	const widgetsServer = {
		serverId: 'widgets',
		serverName: 'widgets',
		kodyName: 'widgets',
	}
	const capabilityMatches: Array<SearchMatch> = [
		{
			type: 'capability',
			name: 'mcp:widgets:createwidget',
			description: 'Create a widget.',
			domain: 'mcp:widgets',
			source: 'mcp-server',
			mcpServer: {
				...widgetsServer,
				mcpToolName: 'create_widget',
				toolName: 'createwidget',
			},
			inputTypeDefinition: 'type CreateWidgetInput = { name: string }',
		},
		{
			type: 'capability',
			name: 'mcp:widgets:listwidgets',
			description: 'List widgets.',
			domain: 'mcp:widgets',
			source: 'mcp-server',
			mcpServer: {
				...widgetsServer,
				mcpToolName: 'list_widgets',
				toolName: 'listwidgets',
			},
			inputTypeDefinition: compact.definition,
			inputTypeDefinitionTruncated: true,
		},
		{
			type: 'capability',
			name: 'fourth_capability',
			description: 'Beyond the top inline set.',
			domain: 'meta',
			source: 'builtin',
		},
	]
	const capabilityListMarkdown = listMarkdown(capabilityMatches)
	expect(capabilityListMarkdown).not.toMatch(
		/fourth_capability[\s\S]*kody\.fourth_capability\(args\)/,
	)
	const [slimWithShape, slimTruncated, slimWithoutShape] =
		slim(capabilityMatches)
	expect(slimWithShape).toMatchObject({
		type: 'capability',
		inputTypeDefinition: 'type CreateWidgetInput = { name: string }',
	})
	expect(slimTruncated).toMatchObject({
		type: 'capability',
		inputTypeDefinition: compact.definition,
		inputTypeDefinitionTruncated: true,
	})
	expect(slimWithoutShape).toMatchObject({ type: 'capability' })
	expect(slimWithoutShape).not.toHaveProperty('inputTypeDefinition')
	expect(slimWithoutShape).not.toHaveProperty('inputTypeDefinitionTruncated')

	const mcpDetail = capabilityDetail(
		{
			name: 'mcp:widgets:createwidget',
			domain: 'mcp:widgets',
			description: 'Create a widget.',
			readOnly: false,
			idempotent: false,
			source: 'mcp-server',
			mcpServer: {
				...widgetsServer,
				mcpToolName: 'create_widget',
				toolName: 'createwidget',
			},
			inputFields: ['name'],
			requiredInputFields: ['name'],
			inputTypeDefinition: 'type CreateWidgetInput = { name: string }',
		},
		{ relatedOperationCount: 2 },
	)
	expect(mcpDetail.markdown).not.toContain('capability:mcp:widgets:listwidgets')
	expect(mcpDetail.structured).toMatchObject({
		type: 'capability',
		relatedOperationCount: 2,
	})
	expect(mcpDetail.structured).not.toHaveProperty('relatedOperations')
	expect(
		capabilityDetail({
			name: 'codingGuideGet',
			domain: 'coding',
			description: 'Load an official guide.',
			inputFields: ['guide'],
			requiredInputFields: ['guide'],
			inputTypeDefinition: 'type CodingGuideGetInput = { guide: string }',
		}).structured,
	).not.toHaveProperty('relatedOperations')
})
