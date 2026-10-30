import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { env } from 'cloudflare:workers'
import { expect, test, vi } from 'vitest'
import { McpCallerError } from '#mcp/caller-error.ts'
import { getStaticRegistry } from '#mcp/capabilities/registry.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import {
	callerContextFields,
	errorFields,
	logMcpEvent,
} from '#mcp/observability.ts'
import { ensureEntitlementTestSchema } from '#worker/entitlements/test-schema.ts'
import { consoleInfo, consoleWarn } from '#worker/test-support/console-spies.ts'
import { silenceIncidentalRuntimeWarnings } from '#worker/test-support/incidental-runtime-warnings.ts'
import {
	ensurePackageSubscriptionTestSchema,
	seedAccount,
} from '#worker/test-support/workers-seed.ts'

const repoMockModule = vi.hoisted(() => ({
	ensureEntitySource: vi.fn(),
	syncArtifactSourceSnapshot: vi.fn(),
}))

const packageServiceMockModule = vi.hoisted(() => ({
	refreshSavedPackageProjection: vi.fn(),
}))

const pendingSecretsMockModule = vi.hoisted(() => ({
	buildPendingPackageSecretApprovalsSummary: vi.fn(),
	formatPendingPackageSecretApprovalsGuidance: vi.fn(),
}))

vi.mock('#worker/repo/source-service.ts', () => ({
	ensureEntitySource: (...args: Array<unknown>) =>
		repoMockModule.ensureEntitySource(...args),
}))

vi.mock('#worker/repo/source-sync.ts', () => ({
	syncArtifactSourceSnapshot: (...args: Array<unknown>) =>
		repoMockModule.syncArtifactSourceSnapshot(...args),
}))

vi.mock('#worker/package-registry/service.ts', () => ({
	refreshSavedPackageProjection: (...args: Array<unknown>) =>
		packageServiceMockModule.refreshSavedPackageProjection(...args),
}))

vi.mock('#mcp/secrets/pending-package-secret-approvals.ts', () => ({
	buildPendingPackageSecretApprovalsSummary: (...args: Array<unknown>) =>
		pendingSecretsMockModule.buildPendingPackageSecretApprovalsSummary(...args),
	formatPendingPackageSecretApprovalsGuidance: (...args: Array<unknown>) =>
		pendingSecretsMockModule.formatPendingPackageSecretApprovalsGuidance(
			...args,
		),
}))

function createTestEnv(overrides: Record<string, unknown> = {}) {
	return {
		USER_METER: env.USER_METER,
		APP_DB: env.APP_DB,
		...overrides,
	} as unknown as Env
}

function takeMcpEvents() {
	const events = consoleInfo.mock.calls
		.filter(([tag, json]) => tag === 'mcp-event' && typeof json === 'string')
		.map(([, json]) => JSON.parse(json as string) as Record<string, unknown>)
	consoleInfo.mockClear()
	return events
}

const searchSuccess = {
	category: 'mcp',
	tool: 'search',
	toolName: 'search',
	outcome: 'success',
	durationMs: 42,
	baseUrl: 'https://example.com',
	hasUser: false,
} as const

const observedPackageJson = JSON.stringify({
	name: '@user/observed-package',
	exports: { '.': './src/index.ts' },
	kody: {
		id: 'observed-package',
		description: 'Observation test package.',
		app: { entry: './src/app.ts' },
	},
})
const observedIndexSource =
	'export default async function main() { return { ok: true } }\n'
const observedAppSource =
	'export default { async fetch() { return new Response("ok") } }\n'

async function seedObservedPackageUser() {
	await ensureEntitlementTestSchema(env.APP_DB)
	await ensurePackageSubscriptionTestSchema(env.APP_DB)
	await env.APP_DB.prepare(`DELETE FROM entity_sources WHERE user_id = ?`)
		.bind('user-1')
		.run()
	await env.APP_DB.prepare(`DELETE FROM saved_packages WHERE user_id = ?`)
		.bind('user-1')
		.run()
	await env.APP_DB.prepare(`DELETE FROM users WHERE stable_user_id = ?`)
		.bind('user-1')
		.run()
	await seedAccount({
		db: env.APP_DB,
		email: 'user@example.com',
		username: 'user',
		stableUserId: ownerIdFromStored('user-1'),
		plan: 'max',
	})
	const now = '2026-04-13T00:00:00.000Z'
	await env.APP_DB.prepare(
		`INSERT INTO saved_packages (
			id, user_id, name, kody_id, description, tags_json, search_text,
			source_id, has_app, hidden, is_private, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, '[]', NULL, ?, 1, 0, 1, ?, ?)`,
	)
		.bind(
			'package-1',
			'user-1',
			'@user/observed-package',
			'observed-package',
			'Observation test package.',
			'package-package-1',
			now,
			now,
		)
		.run()
	await env.APP_DB.prepare(
		`INSERT INTO entity_sources (
			id, user_id, entity_kind, entity_id, repo_id, published_commit,
			indexed_commit, manifest_path, source_root, created_at, updated_at
		) VALUES (?, ?, 'package', ?, ?, ?, ?, 'package.json', '/', ?, ?)`,
	)
		.bind(
			'package-package-1',
			'user-1',
			'package-1',
			'package-package-1',
			'published-commit-1',
			'published-commit-1',
			now,
			now,
		)
		.run()
}

test('observability helpers normalize errors and emit resilient mcp-event logs', () => {
	expect(errorFields(new TypeError('bad'))).toEqual({
		errorName: 'TypeError',
		errorMessage: 'bad',
	})
	expect(errorFields('plain')).toEqual({
		errorName: 'Unknown',
		errorMessage: 'plain',
	})

	logMcpEvent(searchSuccess)
	expect(consoleInfo.mock.calls[0]?.[0]).toBe('mcp-event')
	expect(takeMcpEvents()).toEqual([
		expect.objectContaining({
			category: 'mcp',
			tool: 'search',
			outcome: 'success',
			durationMs: 42,
			timestamp: expect.any(String),
		}),
	])

	consoleInfo.mockImplementation(() => {
		throw new Error('console boom')
	})
	consoleWarn.mockImplementation(() => {})
	expect(() => logMcpEvent({ ...searchSuccess, durationMs: 1 })).not.toThrow()
	expect(consoleWarn.mock.calls[0]?.[0]).toBe('mcp-event-failed')

	consoleInfo.mockImplementation(() => {})
	expect(() =>
		logMcpEvent({
			...searchSuccess,
			outcome: 'failure',
			durationMs: 1,
			sandboxError: true,
			errorName: 'Error',
			errorMessage: 'user code failed',
			cause: new Error('user code failed'),
		}),
	).not.toThrow()
})

test('callerContextFields exposes the caller user id and logMcpEvent serializes it', () => {
	expect(
		callerContextFields(
			createMcpCallerContext({
				source: { kind: 'mcp-oauth' },
				baseUrl: 'https://example.com',
				user: {
					userId: personIdFromStored('user-1'),
					email: 'user@example.com',
					displayName: 'User One',
				},
			}),
		),
	).toMatchObject({
		baseUrl: 'https://example.com',
		hasUser: true,
		userId: ownerIdFromStored('user-1'),
	})
	expect(
		callerContextFields(
			createMcpCallerContext({
				source: { kind: 'mcp-oauth' },
				baseUrl: 'https://example.com',
				user: null,
			}),
		),
	).toMatchObject({ hasUser: false, userId: undefined })

	logMcpEvent({
		category: 'mcp',
		tool: 'capability',
		capabilityName: 'valueGet',
		outcome: 'success',
		durationMs: 5,
		baseUrl: 'https://example.com',
		hasUser: true,
		userId: ownerIdFromStored('user-1'),
	})
	expect(takeMcpEvents()[0]?.userId).toBe('user-1')
})

test('packageSave logs parse failures, rejects invalid manifests, and logs successful saves', async () => {
	// The worker bundler emits an incidental experimental warning during the
	// successful save's artifact rebuild.
	silenceIncidentalRuntimeWarnings()
	await seedObservedPackageUser()
	const packageSave = (await getStaticRegistry()).capabilityMap['packageSave']
	if (!packageSave) throw new Error('Expected packageSave capability')
	const handler = packageSave.handler
	const userCallerContext = createMcpCallerContext({
		source: { kind: 'mcp-oauth' },
		baseUrl: 'https://example.com',
		user: {
			userId: personIdFromStored('user-1'),
			email: 'user@example.com',
			displayName: 'user',
		},
	})
	await expect(
		handler({}, { env: createTestEnv(), callerContext: userCallerContext }),
	).rejects.toThrow('Invalid input for capability "packageSave"')

	expect(takeMcpEvents()).toEqual([
		expect.objectContaining({
			tool: 'capability',
			capabilityName: 'packageSave',
			capabilitySource: 'builtin',
			outcome: 'failure',
			failurePhase: 'parse_input',
		}),
	])

	const signedInContext = {
		env: createTestEnv(),
		callerContext: userCallerContext,
	}

	const invalidManifest = handler(
		{
			files: [
				{
					path: 'package.json',
					content: JSON.stringify({
						name: 'pkg',
						kody: {
							id: 'pkg',
							description: 'unscoped name',
						},
					}),
				},
			],
		},
		signedInContext,
	)
	await expect(invalidManifest).rejects.toThrow(McpCallerError)
	await expect(invalidManifest).rejects.toThrow('Invalid package.json')

	const wrongScope = handler(
		{
			files: [
				{
					path: 'package.json',
					content: JSON.stringify({
						name: '@other/observed-package',
						exports: {
							'.': './src/index.ts',
						},
						kody: {
							id: 'observed-package',
							description: 'Observation test package.',
						},
					}),
				},
				{ path: 'src/index.ts', content: observedIndexSource },
			],
		},
		signedInContext,
	)
	await expect(wrongScope).rejects.toThrow(McpCallerError)
	await expect(wrongScope).rejects.toThrow(
		'package.json name "@other/observed-package" must use the authenticated user\'s package scope "@user/*".',
	)
	expect(repoMockModule.ensureEntitySource).not.toHaveBeenCalled()

	takeMcpEvents()
	repoMockModule.ensureEntitySource.mockResolvedValue({
		id: 'package-package-1',
		user_id: ownerIdFromStored('user-1'),
		entity_kind: 'package',
		entity_id: 'package-1',
		repo_id: 'package-package-1',
		published_commit: null,
		indexed_commit: null,
		manifest_path: 'package.json',
		source_root: '/',
		created_at: '2026-04-13T00:00:00.000Z',
		updated_at: '2026-04-13T00:00:00.000Z',
		bootstrapAccess: {
			defaultBranch: 'main',
			remote: 'https://example.com/artifacts/package-package-1.git',
			token: 'art_v1_bootstrap?expires=1760000000',
			expiresAt: '2026-06-06T00:00:00.000Z',
		},
	})
	repoMockModule.syncArtifactSourceSnapshot.mockResolvedValue(
		'published-commit-1',
	)
	pendingSecretsMockModule.buildPendingPackageSecretApprovalsSummary.mockResolvedValue(
		null,
	)
	pendingSecretsMockModule.formatPendingPackageSecretApprovalsGuidance.mockReturnValue(
		'',
	)
	packageServiceMockModule.refreshSavedPackageProjection.mockResolvedValue({
		record: {
			id: 'package-1',
			userId: ownerIdFromStored('user-1'),
			name: '@user/observed-package',
			kodyId: 'observed-package',
			description: 'Observation test package.',
			tags: [],
			searchText: null,
			sourceId: 'package-package-1',
			hasApp: true,
			hidden: false,
			isPrivate: true,
			isInternetVisible: false,
			lockedAt: null,
			createdAt: '2026-04-13T00:00:00.000Z',
			updatedAt: '2026-04-13T00:00:00.000Z',
		},
	})
	const bundleArtifactsKvStore = new Map<string, string>()
	const result = await handler(
		{
			confirm_destructive_overwrite: true,
			files: [
				{ path: 'package.json', content: observedPackageJson },
				{ path: 'src/index.ts', content: observedIndexSource },
				{ path: 'src/app.ts', content: observedAppSource },
			],
		},
		{
			env: createTestEnv({
				BUNDLE_ARTIFACTS_KV: {
					get: async (_key: string, type?: 'text' | 'json') => {
						if (type === 'json') {
							return {
								version: 1,
								sourceId: 'package-package-1',
								repoId: 'package-package-1',
								entityKind: 'package',
								entityId: 'package-1',
								publishedCommit: 'published-commit-1',
								manifestPath: 'package.json',
								sourceRoot: '/',
								files: {
									'package.json': observedPackageJson,
									'src/index.ts': observedIndexSource,
									'src/app.ts': observedAppSource,
								},
								createdAt: '2026-04-13T00:00:00.000Z',
							}
						}
						return null
					},
					put: async (key: string, value: string) => {
						bundleArtifactsKvStore.set(key, value)
					},
					delete: async (key: string) => {
						bundleArtifactsKvStore.delete(key)
					},
					list: async (options?: { prefix?: string; cursor?: string }) => ({
						keys: Array.from(bundleArtifactsKvStore.keys())
							.filter((key) => key.startsWith(options?.prefix ?? ''))
							.sort()
							.map((name) => ({ name })),
						list_complete: true,
						cursor: undefined,
					}),
				},
				CLOUDFLARE_ACCOUNT_ID: 'acct',
				CLOUDFLARE_API_TOKEN: 'token',
				CLOUDFLARE_API_BASE_URL: 'https://example.com',
				REPO_SESSION: {
					idFromName(name: string) {
						return name as unknown as DurableObjectId
					},
					get() {
						return {
							openSession: async () => ({
								id: 'session-1',
								source_id: 'source-package-1',
								base_commit: 'published-commit-1',
								source_root: '/',
								conversation_id: null,
								status: 'active',
								expires_at: null,
								last_checkpoint_at: null,
								last_checkpoint_commit: null,
								last_check_run_id: null,
								last_check_tree_hash: null,
								created_at: '2026-04-13T00:00:00.000Z',
								updated_at: '2026-04-13T00:00:00.000Z',
								published_commit: 'published-commit-1',
								manifest_path: 'package.json',
								entity_type: 'package',
							}),
							readFile: async ({ path }: { path: string }) => ({
								path,
								content: path === 'package.json' ? observedPackageJson : null,
							}),
							tree: async () => ({
								path: '/',
								name: '',
								type: 'directory',
								size: 0,
								children: [],
							}),
							discardSession: async () => ({
								ok: true,
								sessionId: 'session-1',
								deleted: true,
							}),
						}
					},
				},
				AI: {
					run: async () => ({
						data: [Array.from({ length: 384 }, () => 0)],
					}),
				},
			}),
			callerContext: userCallerContext,
		},
	)
	expect((result as { package_id: string }).package_id).toBeTruthy()
	expect((result as { has_app: boolean }).has_app).toBe(true)
	expect(repoMockModule.syncArtifactSourceSnapshot).toHaveBeenCalledWith(
		expect.objectContaining({
			sourceId: 'package-package-1',
			destructiveOverwriteConfirmed: true,
			bootstrapAccess: expect.objectContaining({
				remote: 'https://example.com/artifacts/package-package-1.git',
			}),
		}),
	)

	const [successEvent, ...rest] = takeMcpEvents()
	expect(rest).toEqual([])
	expect(successEvent?.outcome).toBe('success')
	expect(successEvent?.failurePhase).toBeUndefined()
}, 60_000)
