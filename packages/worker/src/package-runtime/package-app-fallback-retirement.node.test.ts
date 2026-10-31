/**
 * The calls that still needed the visitor fallback now succeed without it:
 * visitor identity, grandfathered capabilities for one published version, and
 * the internal integration-config helper. Real boundaries: a migrated APP_DB
 * with real accounts and personal orgs, real visit tickets, and the real
 * runtime bridge; the capability handlers themselves are stubbed.
 */
import { DatabaseSync } from 'node:sqlite'
import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { beforeEach, expect, test, vi } from 'vitest'
import { provisionPersonalOrg } from '#worker/orgs/provision.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { PackageAppRuntimeBridge } from './package-app.ts'
import type * as PackageAppAuthority from './package-app-authority.ts'
import type * as PackageAppAuthorityFallback from './package-app-authority-fallback.ts'
import {
	mintPackageAppVisitTicket,
	resetPackageAppVisitNoncesForTests,
} from './package-app-visit-ticket.ts'

const logged = vi.hoisted(() => ({
	fallbacks: [] as Array<{ callName: string; kind: string }>,
	rejections: [] as Array<{ callName: string; kind: string }>,
}))
const readConfig = vi.hoisted(() => vi.fn())

vi.mock('./package-app-authority-fallback.ts', async (importOriginal) => ({
	...(await importOriginal<typeof PackageAppAuthorityFallback>()),
	schedulePackageAppAuthorityFallback: (input: {
		event: { callName: string; kind: string }
	}) => {
		logged.fallbacks.push(input.event)
	},
	schedulePackageAppAuthorityRejection: (input: {
		event: { callName: string; kind: string }
	}) => {
		logged.rejections.push(input.event)
	},
}))

vi.mock('./package-app-authority.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof PackageAppAuthority>()
	return {
		...actual,
		loadPackageAppRunsAs: async () => ({
			status: 'ready',
			personId: 'person-publisher',
			source: 'publisher',
			role: 'owner',
			email: 'publisher@example.com',
			username: 'publisher',
			displayName: 'Publisher',
			request: { org: { slug: 'publisher-org' } },
		}),
	}
})

vi.mock('#mcp/capabilities/registry.ts', () => ({
	getCapabilityRegistryForContext: async () => ({
		capabilityMap: { integrationGet: { name: 'integrationGet' } },
	}),
}))

vi.mock('#mcp/capabilities/integrations/integration-runtime-config.ts', () => ({
	readIntegrationRuntimeConfig: readConfig,
}))

const now = '2026-10-31T00:00:00.000Z'
const baseUrl = 'https://kody.example'

beforeEach(() => {
	logged.fallbacks.length = 0
	logged.rejections.length = 0
	readConfig.mockReset()
	resetPackageAppVisitNoncesForTests()
})

async function setup() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	const db = createD1FromSqlite(sqlite)
	const insertAccount = async (input: {
		email: string
		username: string
		displayName: string
	}) => {
		const stableUserId = testStableUserIdFromEmail(input.email)
		await db
			.prepare(
				`INSERT INTO users (username, email, password_hash, email_verified_at, stable_user_id, personal_org_id, display_name)
				 VALUES (?, ?, 'test-password-hash', ?, ?, ?, ?)`,
			)
			.bind(
				input.username,
				input.email,
				now,
				stableUserId,
				stableUserId,
				input.displayName,
			)
			.run()
		await provisionPersonalOrg(db, {
			stableUserId,
			username: input.username,
			createdAt: now,
		})
		const row = await db
			.prepare(`SELECT personal_org_id FROM users WHERE stable_user_id = ?`)
			.bind(stableUserId)
			.first<{ personal_org_id: string }>()
		return {
			personId: personIdFromStored(stableUserId),
			orgId: ownerIdFromStored(row!.personal_org_id),
			username: input.username,
		}
	}
	const ada = await insertAccount({
		email: 'ada@example.com',
		username: 'ada',
		displayName: 'Ada Visitor',
	})
	const publisher = await insertAccount({
		email: 'publisher@example.com',
		username: 'publisher',
		displayName: 'Publisher',
	})
	const env = { APP_DB: db } as unknown as Env

	const bridgeFor = (input: {
		ownerOrgId: ReturnType<typeof ownerIdFromStored>
		orgSlug: string
		declaredCapabilities?: Array<string>
		capabilityAllowance?: Array<string>
	}) => {
		const visitAudience = {
			host: baseUrl,
			packageId: 'pkg-app',
			kodyId: 'app',
			sourceId: 'source-app',
			publishedCommit: 'commit-1',
		}
		const bridge = new PackageAppRuntimeBridge(
			{
				props: {
					baseUrl,
					userId: input.ownerOrgId,
					orgSlug: input.orgSlug,
					visitor: null,
					email: '',
					displayName: 'package:pkg-app',
					packageId: 'pkg-app',
					kodyId: 'app',
					sourceId: 'source-app',
					publishedCommit: 'commit-1',
					packageStorageGrantIds: ['pkg-app'],
					credentialClientBinding: '',
					packageSecretRefKey: '',
					packageBindingToken: 'binding-token-for-test',
					gatewayProps: null,
					visitAudience,
					declaredCapabilities: input.declaredCapabilities ?? [],
					...(input.capabilityAllowance
						? { capabilityAllowance: input.capabilityAllowance }
						: {}),
				},
				waitUntil() {},
			} as never,
			env,
		)
		const internals = bridge as unknown as {
			invokeCapability: (...args: Array<unknown>) => Promise<unknown>
			createCallerContext: (...args: Array<unknown>) => Promise<unknown>
			createRunsAsCallerContext: (...args: Array<unknown>) => unknown
			findVisitorGrant: (...args: Array<unknown>) => Promise<unknown>
			requireActingVisit: (...args: Array<unknown>) => Promise<unknown>
		}
		const invoked: Array<{ name: string; mode: unknown }> = []
		internals.createCallerContext = async () => ({ mode: 'legacy' })
		internals.createRunsAsCallerContext = () => ({ mode: 'runs-as' })
		internals.requireActingVisit = async () => null
		internals.invokeCapability = async (_bound, callerContext, call) => {
			const { name } = call as { name: string }
			const mode = (callerContext as { mode: unknown }).mode
			invoked.push({ name, mode })
			if (name === 'metaGetCurrentUser') {
				// What the legacy visitor context answers: the serve owner's
				// email and display name next to the visitor's id.
				return {
					user_id: ada.personId,
					username: 'ada',
					email: 'owner-context@example.com',
					display_name: 'Owner context',
					org: { slug: input.orgSlug },
					profile: null,
				}
			}
			return { ok: true, name }
		}
		const mintVisit = async (scopes: Array<string>) =>
			(
				await mintPackageAppVisitTicket({
					env: {} as Pick<Env, 'SECRET_STORE_KEY'>,
					visitor: { userId: ada.personId, username: 'ada', role: 'owner' },
					owner: {
						userId: input.ownerOrgId,
						orgSlug: input.orgSlug,
						email: '',
						displayName: input.orgSlug,
					},
					audience: visitAudience,
					credentialClientBinding: 'run:ada',
					grantId: 'grant-1',
					scopes,
				})
			).ticket
		return { bridge, internals, invoked, mintVisit }
	}
	return { ada, publisher, bridgeFor }
}

test('metaGetCurrentUser names the visitor with their own identity, and never logs a fallback', async () => {
	const t = await setup()

	// Visiting your own app: the same answer the fallback gave.
	const own = t.bridgeFor({ ownerOrgId: t.ada.orgId, orgSlug: 'ada' })
	await expect(
		own.bridge.callCapability({
			name: 'metaGetCurrentUser',
			visitTicket: await own.mintVisit(['profile']),
		}),
	).resolves.toEqual({
		user_id: t.ada.personId,
		username: 'ada',
		email: 'ada@example.com',
		display_name: 'Ada Visitor',
		org: { slug: 'ada' },
		profile: null,
		role: 'owner',
	})

	// Someone else's app: no email unless the visitor shared it.
	const other = t.bridgeFor({
		ownerOrgId: t.publisher.orgId,
		orgSlug: 'publisher',
	})
	other.internals.findVisitorGrant = async () => ({ scopes: ['profile'] })
	const withoutConsent = (await other.bridge.callCapability({
		name: 'metaGetCurrentUser',
		visitTicket: await other.mintVisit(['profile']),
	})) as Record<string, unknown>
	expect(withoutConsent).toMatchObject({
		user_id: t.ada.personId,
		username: 'ada',
		email: '',
		display_name: 'Ada Visitor',
	})
	other.internals.findVisitorGrant = async () => ({
		scopes: ['profile', 'email'],
	})
	const withConsent = (await other.bridge.callCapability({
		name: 'metaGetCurrentUser',
		visitTicket: await other.mintVisit(['profile', 'email']),
	})) as Record<string, unknown>
	expect(withConsent.email).toBe('ada@example.com')
	for (const answer of [withoutConsent, withConsent]) {
		expect(JSON.stringify(answer)).not.toContain('owner-context')
		expect(JSON.stringify(answer)).not.toContain('publisher@example.com')
		expect(answer.display_name).not.toBe('Publisher')
	}
	expect(logged.fallbacks).toEqual([])
})

test('kody.appPublisherGet() is the explicit way to read the publisher', async () => {
	const t = await setup()
	const { bridge } = t.bridgeFor({
		ownerOrgId: t.publisher.orgId,
		orgSlug: 'publisher',
	})
	await expect(bridge.appPublisherGet()).resolves.toEqual({
		user_id: 'person-publisher',
		username: 'publisher',
		email: 'publisher@example.com',
		display_name: 'Publisher',
		org: { slug: 'publisher' },
		source: 'publisher',
	})
})

test('an allowance covers exactly its capabilities for this published version, as the runs-as person', async () => {
	const t = await setup()
	const app = t.bridgeFor({
		ownerOrgId: t.publisher.orgId,
		orgSlug: 'publisher',
		capabilityAllowance: ['secretList'],
	})
	await expect(
		app.bridge.callCapability({ name: 'secretList' }),
	).resolves.toEqual({ ok: true, name: 'secretList' })
	expect(app.invoked).toEqual([{ name: 'secretList', mode: 'runs-as' }])
	expect(logged.fallbacks).toEqual([])

	// Not a global loosening: an unlisted capability is still not declared.
	await app.bridge.callCapability({ name: 'secretSet' })
	expect(logged.fallbacks).toEqual([
		expect.objectContaining({
			callName: 'secretSet',
			kind: 'capability_not_declared',
		}),
	])
})

test('__kodyIntegrationRuntimeConfig is internal: no declaration, no fallback, no rejection', async () => {
	const t = await setup()
	readConfig.mockResolvedValue({
		integration: { name: 'github', apiBaseUrl: null, requiredHosts: [] },
	})
	const app = t.bridgeFor({
		ownerOrgId: t.publisher.orgId,
		orgSlug: 'publisher',
	})
	await expect(
		app.bridge.callCapability({
			name: '__kodyIntegrationRuntimeConfig',
			args: { name: 'github' },
		}),
	).resolves.toEqual({
		integration: { name: 'github', apiBaseUrl: null, requiredHosts: [] },
	})
	expect(readConfig).toHaveBeenCalledWith(
		expect.objectContaining({
			callerContext: { mode: 'runs-as' },
			integrationGet: { name: 'integrationGet' },
			args: { name: 'github' },
		}),
	)
	expect(logged.fallbacks).toEqual([])
	expect(logged.rejections).toEqual([])
})
