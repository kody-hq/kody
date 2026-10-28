import { DatabaseSync } from 'node:sqlite'
import {
	ownerIdFromStored,
	personalOrgId,
	personIdFromStored,
	type OwnerId,
} from '@kody-internal/shared/owner-person-ids.ts'
import { type McpCallerContext } from '@kody-internal/shared/chat.ts'
import { type OrgRole } from '@kody-internal/shared/request-context.ts'
import { afterEach, expect, test, vi } from 'vitest'
import { expandSecretPlaceholders } from '#mcp/fetch-gateway.ts'
import * as declaredProvider from '#mcp/secrets/secret-providers/declared-provider.ts'
import { SecretProviderGrantDeniedError } from '#mcp/secrets/secret-providers/errors.ts'
import * as secretProviderService from '#mcp/secrets/secret-providers/service.ts'
import { saveSecret } from '#mcp/secrets/service.ts'
import * as featureFlags from '#worker/feature-flags/service.ts'
import { createOrganization } from '#worker/orgs/create-organization.ts'
import { provisionPersonalOrg } from '#worker/orgs/provision.ts'
import { insertSavedPackage } from '#worker/package-registry/repo.ts'
import * as runtimeArtifacts from '#worker/package-runtime/published-runtime-artifacts.ts'
import * as entitySources from '#worker/repo/entity-sources.ts'
import { deriveRequestContext } from '#worker/request-context/request-context.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import {
	createAuditTestDb,
	createTestOrgAuditWriter,
} from '#worker/test-support/create-audit-db.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'
import { openCredentialClient } from './credential-client.ts'
import {
	isCredentialReferenceDeclared,
	type CredentialNeedReference,
} from './credential-need-enforcement.ts'
import * as needsClosure from './credential-needs-closure.ts'
import {
	savedCredentialNeeds,
	type CredentialNeed,
} from './credential-needs.ts'
import * as stampPresence from './credential-stamp-presence.ts'
import { resolveCredential } from './resolve-credential.ts'

vi.mock('cloudflare:workers', async (importOriginal) => ({
	...(await importOriginal<typeof import('cloudflare:workers')>()),
	waitUntil: () => {},
}))

vi.mock(
	'#worker/test-support/apply-all-migrations.ts',
	async (importOriginal) =>
		(await import('./cached-migrations.test-support.ts')).withCachedMigrations(
			await importOriginal(),
		),
)

const now = '2026-10-15T00:00:00.000Z'
const keyValue = 're_live_secret_value_123'

afterEach(() => {
	vi.restoreAllMocks()
})

async function setup() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	const db = createD1FromSqlite(sqlite)
	const env = {
		APP_DB: db,
		AUDIT_DB: createAuditTestDb(),
		...createInMemoryUserMeterEnv().env,
		COOKIE_SECRET: 'test-cookie-secret',
		SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum',
	} as unknown as Env
	const stableUserId = testStableUserIdFromEmail('bea@example.com')
	const personId = personIdFromStored(stableUserId)
	await provisionPersonalOrg(db, {
		stableUserId,
		username: 'bea',
		createdAt: now,
	})
	const created = await createOrganization(
		db,
		{} as Pick<Env, 'BUNDLE_ARTIFACTS_KV'>,
		{
			personId,
			audit: createTestOrgAuditWriter(),
			slug: 'acme-tools',
			displayName: 'Acme',
		},
	)
	if (!created.ok) throw new Error(created.error)
	const acme = await db
		.prepare(`SELECT id FROM orgs WHERE slug = 'acme-tools'`)
		.first<{ id: string }>()
	const acmeId = ownerIdFromStored(acme!.id)
	const personalId = personalOrgId(personId)
	const storeSecret = async (ownerId: OwnerId, name: string) => {
		await saveSecret({
			env,
			userId: ownerId,
			scope: 'user',
			name,
			value: keyValue,
			audit: null,
		})
		await db
			.prepare(
				`UPDATE secret_entries
				SET kind = 'secret', provider = ?, allowed_hosts = ?
				WHERE name = ? AND bucket_id IN (
					SELECT id FROM secret_buckets WHERE user_id = ? AND scope = 'user'
				)`,
			)
			.bind(name, JSON.stringify(['api.resend.com']), name, ownerId)
			.run()
	}
	const savePackage = async (input: {
		ownerId: OwnerId
		name: string
		internetVisible?: boolean
	}) => {
		const packageId = crypto.randomUUID()
		await insertSavedPackage(
			db,
			{
				id: packageId,
				user_id: input.ownerId,
				name: input.name,
				kody_id: input.name.split('/')[1]!,
				description: 'test package',
				tags_json: '[]',
				search_text: null,
				source_id: `source-${packageId}`,
				has_app: 0,
				has_skills: 0,
				hidden: 0,
				is_private: 1,
				is_internet_visible: input.internetVisible ? 1 : 0,
				created_at: now,
				updated_at: now,
			},
			null,
			{ stamp: false },
		)
		return packageId
	}
	const requestIn = (orgId: OwnerId, role: OrgRole = 'owner') =>
		deriveRequestContext({
			user: { userId: personId, username: 'bea' },
			source: { kind: 'mcp-oauth' },
			orgBinding: { org: { id: orgId, slug: 'acme-tools' }, role },
		})
	const fill = (input: {
		orgId: OwnerId
		packageId: string | null
		header: string
	}) =>
		expandSecretPlaceholders({
			request: new Request('https://api.resend.com/emails', {
				headers: { Authorization: input.header },
			}),
			props: {
				baseUrl: 'https://example.com',
				userId: input.orgId,
				email: null,
				request: requestIn(input.orgId),
				storageContext: input.packageId
					? {
							sessionId: null,
							appId: input.packageId,
							packageId: input.packageId,
							storageId: input.packageId,
						}
					: null,
				...(input.packageId
					? { grantedSecretAuthorityPackageIds: [input.packageId] }
					: {}),
			},
			env,
		}).then((expanded) => expanded.request.headers.get('Authorization'))
	const clientContext = (orgId: OwnerId, packageId: string | null) => ({
		env,
		callerContext: {
			baseUrl: 'https://example.com',
			request: requestIn(orgId),
			user: null,
		} as unknown as McpCallerContext,
		binding: 'run:test',
		packageId,
	})
	return {
		db,
		env,
		acmeId,
		personalId,
		storeSecret,
		savePackage,
		fill,
		clientContext,
	}
}

function need(
	key: string,
	extra: Partial<CredentialNeed> = {},
): CredentialNeed {
	return { key, provider: key, description: 'test', multiple: false, ...extra }
}

function enforcement(enabled: boolean) {
	vi.spyOn(featureFlags, 'isFeatureGloballyEnabled').mockResolvedValue(enabled)
}

function stamp(present: boolean) {
	vi.spyOn(stampPresence, 'packageCarriesCredentialStamp').mockResolvedValue(
		present,
	)
}

function declare(stored: Array<CredentialNeed>, fresh = stored) {
	return vi
		.spyOn(needsClosure, 'loadPublishedCredentialNeeds')
		.mockImplementation(async (input) => (input.fresh ? fresh : stored))
}

test('with the flag off a team package fills any placeholder, as today', async () => {
	const t = await setup()
	await t.storeSecret(t.acmeId, 'RESEND')
	const packageId = await t.savePackage({
		ownerId: t.acmeId,
		name: '@acme/mailer',
	})
	enforcement(false)
	declare([])
	await expect(
		t.fill({ orgId: t.acmeId, packageId, header: 'Bearer {{secret:RESEND}}' }),
	).resolves.toBe(`Bearer ${keyValue}`)
})

test('a stamped package fills only declared slots even when the flag is off', async () => {
	const t = await setup()
	await t.storeSecret(t.acmeId, 'RESEND')
	const packageId = await t.savePackage({
		ownerId: t.acmeId,
		name: '@acme/mailer',
	})
	enforcement(false)
	stamp(true)
	declare([])
	const error = await t
		.fill({ orgId: t.acmeId, packageId, header: 'Bearer {{secret:RESEND}}' })
		.catch((caught: unknown) => caught as Error)
	expect(error).toMatchObject({
		code: 'credential_need_undeclared',
		key: 'RESEND',
	})
	expect((error as Error).message).not.toContain(keyValue)

	declare([need('RESEND')])
	await expect(
		t.fill({ orgId: t.acmeId, packageId, header: 'Bearer {{secret:RESEND}}' }),
	).resolves.toBe(`Bearer ${keyValue}`)
})

test('a stamped package owned by another org is still limited to its declarations', async () => {
	const t = await setup()
	await t.storeSecret(t.personalId, 'RESEND')
	const packageId = await t.savePackage({
		ownerId: t.acmeId,
		name: '@acme/mailer',
	})
	enforcement(false)
	stamp(true)
	declare([need('RESEND')])
	const declared = await t
		.fill({
			orgId: t.personalId,
			packageId,
			header: 'Bearer {{secret:RESEND}}',
		})
		.catch((caught: unknown) => caught)
	expect(declared).not.toMatchObject({ code: 'credential_need_undeclared' })

	declare([])
	await expect(
		t.fill({
			orgId: t.personalId,
			packageId,
			header: 'Bearer {{secret:RESEND}}',
		}),
	).rejects.toMatchObject({ code: 'credential_need_undeclared' })
})

test('stamp presence follows a package owned by another org', async () => {
	const t = await setup()
	const packageId = await t.savePackage({
		ownerId: t.acmeId,
		name: '@acme/mailer',
	})
	vi.spyOn(runtimeArtifacts, 'hasPublishedRuntimeArtifacts').mockReturnValue(
		true,
	)
	vi.spyOn(runtimeArtifacts, 'readPublishedCredentialStamp').mockResolvedValue({
		version: 1,
		keys: ['RESEND'],
		depStamps: [],
		stampHash: 'abc',
	})
	vi.spyOn(entitySources, 'getEntitySourceById').mockResolvedValue({
		published_commit: 'commit-1',
		user_id: t.acmeId,
	} as unknown as Awaited<ReturnType<typeof entitySources.getEntitySourceById>>)
	await expect(
		stampPresence.packageCarriesCredentialStamp({
			env: t.env,
			request: null,
			orgId: t.personalId,
			packageId,
		}),
	).resolves.toBe(true)
})

test('a stamped package limits its author; an unstamped author package does not', async () => {
	const t = await setup()
	await t.storeSecret(t.personalId, 'RESEND')
	const own = await t.savePackage({
		ownerId: t.personalId,
		name: '@bea/mailer',
	})
	enforcement(false)
	stamp(true)
	declare([])
	await expect(
		t.fill({
			orgId: t.personalId,
			packageId: own,
			header: 'Bearer {{secret:RESEND}}',
		}),
	).rejects.toMatchObject({ code: 'credential_need_undeclared' })

	stamp(false)
	await expect(
		t.fill({
			orgId: t.personalId,
			packageId: own,
			header: 'Bearer {{secret:RESEND}}',
		}),
	).resolves.toBe(`Bearer ${keyValue}`)
})

test('a stamped package secret read by name is limited even when the flag is off', async () => {
	const t = await setup()
	await t.storeSecret(t.acmeId, 'RESEND')
	const packageId = await t.savePackage({
		ownerId: t.acmeId,
		name: '@acme/mailer',
	})
	enforcement(false)
	stamp(true)
	declare([])
	const read = (name: string) =>
		resolveCredential({
			env: t.env,
			orgId: t.acmeId,
			actor: t.clientContext(t.acmeId, packageId).callerContext.request,
			packageStamp: { kind: 'attested', packageId },
			baseUrl: 'https://example.com',
			credential: {
				use: 'secret',
				name,
				scope: 'user',
				storageContext: {
					sessionId: null,
					appId: null,
					packageId,
				},
			},
		})
	await expect(read('RESEND')).rejects.toMatchObject({
		code: 'credential_need_undeclared',
	})
	declare([need('RESEND')])
	await expect(read('RESEND')).resolves.toMatchObject({ found: true })

	declare([need('RESEND', { kind: 'signing' })])
	await expect(read('RESEND')).resolves.toMatchObject({ found: true })
})

test('a stamped package webhook secret stays on the legacy access path', async () => {
	const t = await setup()
	await t.storeSecret(t.acmeId, 'RESEND')
	const packageId = await t.savePackage({
		ownerId: t.acmeId,
		name: '@acme/mailer',
	})
	enforcement(false)
	stamp(true)
	declare([])
	await expect(
		resolveCredential({
			env: t.env,
			orgId: t.acmeId,
			actor: t.clientContext(t.acmeId, packageId).callerContext.request,
			packageStamp: { kind: 'attested', packageId },
			baseUrl: 'https://example.com',
			credential: { use: 'webhook-secret', name: 'RESEND' },
		}),
	).resolves.toMatchObject({ found: true })
})

test('with the flag on a team package fills only what it declares', async () => {
	const t = await setup()
	await t.storeSecret(t.acmeId, 'RESEND')
	const packageId = await t.savePackage({
		ownerId: t.acmeId,
		name: '@acme/mailer',
	})
	enforcement(true)
	declare([])
	const error = await t
		.fill({ orgId: t.acmeId, packageId, header: 'Bearer {{secret:RESEND}}' })
		.catch((caught: unknown) => caught as Error)
	expect(error).toMatchObject({
		code: 'credential_need_undeclared',
		key: 'RESEND',
	})
	expect((error as Error).message).not.toContain(packageId)
	expect((error as Error).message).not.toContain(keyValue)

	declare([need('RESEND')])
	await expect(
		t.fill({ orgId: t.acmeId, packageId, header: 'Bearer {{secret:RESEND}}' }),
	).resolves.toBe(`Bearer ${keyValue}`)

	// Ad hoc code (no package stamp) is never limited.
	await expect(
		t.fill({
			orgId: t.acmeId,
			packageId: null,
			header: 'Bearer {{secret:RESEND}}',
		}),
	).resolves.toBe(`Bearer ${keyValue}`)
})

test('a dependency need declared after the package published counts through the fresh closure', async () => {
	const t = await setup()
	await t.storeSecret(t.acmeId, 'RESEND')
	const packageId = await t.savePackage({
		ownerId: t.acmeId,
		name: '@acme/mailer',
	})
	enforcement(true)
	const closure = declare([], [need('RESEND')])
	await expect(
		t.fill({ orgId: t.acmeId, packageId, header: 'Bearer {{secret:RESEND}}' }),
	).resolves.toBe(`Bearer ${keyValue}`)
	expect(closure.mock.calls.map(([input]) => input.fresh)).toEqual([
		false,
		true,
	])
})

test("the author's own personal package is exempt until it goes internet-visible", async () => {
	const t = await setup()
	await t.storeSecret(t.personalId, 'RESEND')
	enforcement(true)
	declare([])
	const own = await t.savePackage({
		ownerId: t.personalId,
		name: '@bea/mailer',
	})
	await expect(
		t.fill({
			orgId: t.personalId,
			packageId: own,
			header: 'Bearer {{secret:RESEND}}',
		}),
	).resolves.toBe(`Bearer ${keyValue}`)

	const visible = await t.savePackage({
		ownerId: t.personalId,
		name: '@bea/public-mailer',
		internetVisible: true,
	})
	await expect(
		t.fill({
			orgId: t.personalId,
			packageId: visible,
			header: 'Bearer {{secret:RESEND}}',
		}),
	).rejects.toMatchObject({ code: 'credential_need_undeclared' })

	const fork = await t.savePackage({
		ownerId: t.personalId,
		name: '@bea/forked',
	})
	await t.db
		.prepare(
			`INSERT INTO community_forks (
				id, listing_id, forker_user_id, origin_commit, forked_package_id,
				forked_source_id, target_kody_id
			) VALUES (?, 'listing', ?, 'origin', ?, 'source', 'forked')`,
		)
		.bind(crypto.randomUUID(), t.personalId, fork)
		.run()
	await expect(
		t.fill({
			orgId: t.personalId,
			packageId: fork,
			header: 'Bearer {{secret:RESEND}}',
		}),
	).rejects.toMatchObject({ code: 'credential_need_undeclared' })
})

test('credential(key) in a team package needs the key declared', async () => {
	const t = await setup()
	await t.storeSecret(t.acmeId, 'resend')
	const packageId = await t.savePackage({
		ownerId: t.acmeId,
		name: '@acme/mailer',
	})
	enforcement(true)
	declare([])
	const refused = await openCredentialClient(
		t.clientContext(t.acmeId, packageId),
		{ key: 'resend' },
	).then(
		() => {
			throw new Error('Expected a rejection.')
		},
		(caught: unknown) => caught as Error & { body?: unknown },
	)
	expect(refused).toMatchObject({
		body: { code: 'credential_need_undeclared' },
	})

	await expect(
		openCredentialClient(t.clientContext(t.acmeId, null), { key: 'resend' }),
	).resolves.toMatchObject({ key: 'resend' })

	declare([need('resend', { kind: undefined })])
	await expect(
		openCredentialClient(t.clientContext(t.acmeId, packageId), {
			key: 'resend',
		}),
	).resolves.toMatchObject({ key: 'resend' })
})

test('credential(key) checks the calling package even when a sibling entry declares the key', async () => {
	const t = await setup()
	await t.storeSecret(t.acmeId, 'resend')
	const packageId = await t.savePackage({
		ownerId: t.acmeId,
		name: '@acme/mailer',
	})
	enforcement(true)
	declare([])
	await expect(
		openCredentialClient(
			{
				...t.clientContext(t.acmeId, packageId),
				runNeeds: async () =>
					new Map(
						savedCredentialNeeds([need('resend')]).map((item) => [
							item.key,
							item,
						]),
					),
			},
			{ key: 'resend' },
		),
	).rejects.toMatchObject({ body: { code: 'credential_need_undeclared' } })
	// Reading the entry package's mappings does not widen declared use.
	await expect(
		openCredentialClient(
			{
				...t.clientContext(t.acmeId, packageId),
				runNeeds: async () =>
					new Map(
						savedCredentialNeeds([need('resend')]).map((item) => [
							item.key,
							item,
						]),
					),
				runEntries: async () => ({
					packageIds: ['entry-package'],
					entryByKey: new Map([['resend', 'entry-package']]),
				}),
			},
			{ key: 'resend' },
		),
	).rejects.toMatchObject({ body: { code: 'credential_need_undeclared' } })
})

test('credential(key) resolves a key only the fresh closure declares as declared', async () => {
	const t = await setup()
	await t.storeSecret(t.acmeId, 'resend')
	const packageId = await t.savePackage({
		ownerId: t.acmeId,
		name: '@acme/mailer',
	})
	enforcement(true)
	declare([], [need('MAIL', { kind: 'secret', provider: 'resend' })])
	await expect(
		openCredentialClient(
			{
				...t.clientContext(t.acmeId, packageId),
				runNeeds: async () => new Map(),
			},
			{ key: 'MAIL' },
		),
	).resolves.toMatchObject({ key: 'MAIL', name: 'resend' })
})

test('credential.named is refused in a personal package limited to its declarations', async () => {
	const t = await setup()
	await t.storeSecret(t.personalId, 'RESEND')
	declare([])
	const visible = await t.savePackage({
		ownerId: t.personalId,
		name: '@bea/public-mailer',
		internetVisible: true,
	})
	const own = await t.savePackage({
		ownerId: t.personalId,
		name: '@bea/mailer',
	})
	const openNamed = (packageId: string) =>
		openCredentialClient(t.clientContext(t.personalId, packageId), {
			name: 'RESEND',
		})

	enforcement(false)
	stamp(false)
	await expect(openNamed(visible)).resolves.toMatchObject({ name: 'RESEND' })
	await expect(openNamed(own)).resolves.toMatchObject({ name: 'RESEND' })

	stamp(true)
	await expect(openNamed(own)).rejects.toMatchObject({
		body: { code: 'credential_denied' },
	})
	stamp(false)

	enforcement(true)
	await expect(openNamed(visible)).rejects.toMatchObject({
		body: { code: 'credential_denied' },
	})
	await expect(openNamed(own)).resolves.toMatchObject({ name: 'RESEND' })
})

test('a missing stamp stays legacy and any stored blob fail-closes', () => {
	expect(stampPresence.storedCredentialStampEnforces(null)).toBe(false)
	expect(stampPresence.storedCredentialStampEnforces(undefined)).toBe(false)
	expect(
		stampPresence.storedCredentialStampEnforces({
			version: 1,
			stampHash: 'abc',
			keys: ['RESEND'],
			depStamps: [],
		}),
	).toBe(true)
	expect(
		stampPresence.storedCredentialStampEnforces({ version: 99, keys: [1] }),
	).toBe(true)
	expect(stampPresence.storedCredentialStampEnforces('not-a-stamp')).toBe(true)
})

test('a package with no artifact binding is unstamped', async () => {
	const t = await setup()
	const packageId = await t.savePackage({
		ownerId: t.acmeId,
		name: '@acme/mailer',
	})
	await expect(
		stampPresence.packageCarriesCredentialStamp({
			env: t.env,
			request: null,
			orgId: t.acmeId,
			packageId,
		}),
	).resolves.toBe(false)
})

test('a declared slot counts only when its kind can fill the use', () => {
	const cases: Array<
		[CredentialNeedReference, Array<CredentialNeed>, boolean]
	> = [
		[{ use: 'secret', name: 'A', scope: null }, [need('A')], true],
		[
			{ use: 'secret', name: 'A', scope: 'user' },
			[need('A', { kind: 'secret' })],
			true,
		],
		[
			{ use: 'secret', name: 'A', scope: null },
			[need('A', { kind: 'oauth' })],
			false,
		],
		[
			{ use: 'secret', name: 'A', scope: null },
			[need('A', { kind: 'signing' })],
			true,
		],
		[{ use: 'secret', name: 'A', scope: 'package' }, [], true],
		[{ use: 'secret', name: 'A', scope: 'user' }, [], false],
		[{ use: 'integration', name: 'gh' }, [need('gh', { kind: 'oauth' })], true],
		[
			{ use: 'integration', name: 'gh' },
			[need('gh', { kind: 'secret' })],
			false,
		],
		[{ use: 'provider', provider: 'op' }, [need('op')], true],
		[
			{ use: 'provider', provider: '1password', boundPackage: '@acme/op' },
			[need('vault', { kind: 'secret-provider', package: '@acme/op' })],
			true,
		],
		[
			{ use: 'provider', provider: '1password', boundPackage: '@acme/fork' },
			[need('vault', { kind: 'secret-provider', package: '@acme/op' })],
			false,
		],
		[
			{ use: 'provider', provider: '1password', boundPackage: null },
			[need('vault', { kind: 'secret-provider', package: '@acme/op' })],
			false,
		],
		[
			{ use: 'key', key: 'vault' },
			[need('vault', { kind: 'secret-provider', package: '@acme/op' })],
			false,
		],
		[
			{ use: 'secret', name: 'vault', scope: null },
			[need('vault', { kind: 'secret-provider', package: '@acme/op' })],
			false,
		],
		[{ use: 'key', key: 'k' }, [need('k', { kind: 'signing' })], true],
		[{ use: 'key', key: 'k' }, [need('other')], false],
	]
	for (const [reference, needs, declared] of cases) {
		expect(
			isCredentialReferenceDeclared(reference, needs),
			JSON.stringify(reference),
		).toBe(declared)
	}
})

test('a stamped package uses a vault provider only through a declared secret-provider slot', async () => {
	const t = await setup()
	const packageId = await t.savePackage({
		ownerId: t.acmeId,
		name: '@acme/deploy',
	})
	await saveSecret({
		env: t.env,
		userId: t.acmeId,
		scope: 'user',
		name: 'opToken',
		value: 'op-sa-token',
		audit: null,
	})
	const providerPackageId = await t.savePackage({
		ownerId: t.acmeId,
		name: '@acme/op',
	})
	await t.db
		.prepare(
			`INSERT INTO secret_provider_bindings (
				user_id, provider_id, package_id, door_secret_name, config_json
			) VALUES (?, '1password', ?, 'opToken', '{}')`,
		)
		.bind(t.acmeId, providerPackageId)
		.run()
	const ref = 'i/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/password'
	const header = `Bearer {{secret/1password:${ref}}}`
	enforcement(false)
	stamp(true)

	declare([])
	const undeclared = await t
		.fill({ orgId: t.acmeId, packageId, header })
		.catch((caught: unknown) => caught as Error)
	expect(undeclared).toMatchObject({ code: 'credential_need_undeclared' })
	expect((undeclared as Error).message).toContain('"kind": "secret-provider"')

	declare([need('vault', { kind: 'secret-provider', package: '@acme/other' })])
	const wrongPackage = await t
		.fill({ orgId: t.acmeId, packageId, header })
		.catch((caught: unknown) => caught as Error)
	expect(wrongPackage).toMatchObject({ code: 'credential_need_undeclared' })
	expect((wrongPackage as Error).message).toContain(
		'binds provider "1password" to package "@acme/op"',
	)

	declare([need('vault', { kind: 'secret-provider', package: '@acme/op' })])
	// Declared: the normal grant check still blocks an ungranted ref.
	vi.spyOn(declaredProvider, 'readDeclaredSecretProviderId').mockResolvedValue(
		'1password',
	)
	const ungranted = await t
		.fill({ orgId: t.acmeId, packageId, header })
		.catch((caught: unknown) => caught as Error)
	expect(ungranted).toBeInstanceOf(SecretProviderGrantDeniedError)

	const resolve = vi
		.spyOn(secretProviderService, 'resolveProviderSecret')
		.mockResolvedValue({
			provider: '1password',
			ref,
			canonicalRef: ref,
			value: 'vault-item-value',
			hosts: ['api.resend.com'],
		})
	await expect(t.fill({ orgId: t.acmeId, packageId, header })).resolves.toBe(
		'Bearer vault-item-value',
	)
	expect(resolve).toHaveBeenCalledWith(
		expect.objectContaining({
			provider: '1password',
			authorityPackageId: packageId,
		}),
	)
})
