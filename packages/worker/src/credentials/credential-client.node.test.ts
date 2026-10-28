import { DatabaseSync } from 'node:sqlite'
import {
	ownerIdFromStored,
	personalOrgId,
	personIdFromStored,
	type OwnerId,
} from '@kody-internal/shared/owner-person-ids.ts'
import { type McpCallerContext } from '@kody-internal/shared/chat.ts'
import { type OrgRole } from '@kody-internal/shared/request-context.ts'
import { expect, test, vi } from 'vitest'
import { executeGatewayFetch } from '#mcp/fetch-gateway.ts'
import { credentialClientHintHeaderName } from '#mcp/credential-client-gateway.ts'
import {
	createCredentialClientKodyTools,
	createCredentialClientOwnerOnlyMessage,
} from '#mcp/credential-client-tools.ts'
import { credentialClientToolNames } from '#mcp/execute-modules/credential-client-source.ts'
import { createRunCredentialClientToolOptions } from '#mcp/run-kody-registry.ts'
import { type CredentialClientToolOptions } from '#mcp/runtime-helper-manifest.ts'
import { runWithCurrentSecretAuthority } from '#mcp/secrets/secret-authority.ts'
import { createCapabilityProxyCredentialClientTools } from '#worker/open-api/capability-proxy.ts'
import { type ApiInvocationContext } from '#worker/open-api/context.ts'
import { signLocalExecutePackageBinding } from '#worker/package-runtime/local-execute-package-binding.ts'
import { saveSecret } from '#mcp/secrets/service.ts'
import { upsertGrant } from '#worker/orgs/access-writes.ts'
import { createOrganization } from '#worker/orgs/create-organization.ts'
import { provisionPersonalOrg } from '#worker/orgs/provision.ts'
import { insertSavedPackage } from '#worker/package-registry/repo.ts'
import { deriveRequestContext } from '#worker/request-context/request-context.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { consoleError } from '#worker/test-support/console-spies.ts'
import {
	createAuditTestDb,
	createTestOrgAuditWriter,
} from '#worker/test-support/create-audit-db.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'
import * as usageModule from '#worker/usage/record-usage.ts'
import { credentialClientHeaderName } from './credential-client-header.ts'
import {
	newRunCredentialClientBinding,
	signCredentialClientHandle,
} from './credential-client-handle.ts'
import {
	normalizeCredentialCallMap,
	type CredentialCallMapInput,
} from './credential-call-map.ts'
import {
	applyCredentialClient,
	loadRunCredentialNeedEntries,
	loadRunCredentialNeeds,
	openCredentialClient,
	openCredentialClients,
	validateCredentialCallMap,
	type CredentialClientContext,
} from './credential-client.ts'
import {
	buildWriteCredentialMappingStatement,
	type CredentialMappingRowTarget,
	deleteCredentialMappingsForMember,
	deleteCredentialMappingsForPackage,
	runCredentialMappingWrite,
} from './credential-mappings.ts'
import * as needsClosure from './credential-needs-closure.ts'
import { type CredentialNeed } from './credential-needs.ts'
import { ownerCredentialForVisitorsRateLimitConfig } from './owner-credential-for-visitors.ts'
import { insertPackageCapabilityApproval } from '#worker/package-capabilities/capability-approvals-repo.ts'

const scheduledAudits = vi.hoisted(() => [] as Array<Promise<unknown>>)

vi.mock('cloudflare:workers', async (importOriginal) => ({
	...(await importOriginal<typeof import('cloudflare:workers')>()),
	waitUntil: (promise: Promise<unknown>) => {
		scheduledAudits.push(promise)
	},
}))

vi.mock(
	'#worker/test-support/apply-all-migrations.ts',
	async (importOriginal) =>
		(await import('./cached-migrations.test-support.ts')).withCachedMigrations(
			await importOriginal(),
		),
)

const now = '2026-10-12T00:00:00.000Z'
const resendKey = 're_live_secret_value_123'

async function setup() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	const db = createD1FromSqlite(sqlite)
	const auditDb = createAuditTestDb()
	const env = {
		APP_DB: db,
		AUDIT_DB: auditDb,
		...createInMemoryUserMeterEnv().env,
		COOKIE_SECRET: 'test-cookie-secret',
		SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum',
	} as unknown as Env
	const people = Object.fromEntries(
		(['ann', 'bea'] as const).map((username) => {
			const stableUserId = testStableUserIdFromEmail(`${username}@example.com`)
			return [
				username,
				{ stableUserId, personId: personIdFromStored(stableUserId) },
			]
		}),
	) as Record<
		'ann' | 'bea',
		{ stableUserId: string; personId: ReturnType<typeof personIdFromStored> }
	>
	for (const [username, person] of Object.entries(people)) {
		await provisionPersonalOrg(db, {
			stableUserId: person.stableUserId,
			username,
			createdAt: now,
		})
	}
	// Bea owns Acme; Ann is a member.
	const created = await createOrganization(
		db,
		{} as Pick<Env, 'BUNDLE_ARTIFACTS_KV'>,
		{
			personId: people.bea.personId,
			audit: createTestOrgAuditWriter(),
			slug: 'acme-clients',
			displayName: 'Acme',
		},
	)
	if (!created.ok) throw new Error(created.error)
	const acme = await db
		.prepare(`SELECT id FROM orgs WHERE slug = 'acme-clients'`)
		.first<{ id: string }>()
	const acmeId = ownerIdFromStored(acme!.id)
	await db
		.prepare(
			`INSERT INTO org_memberships (org_id, user_id, role, created_at)
			 VALUES (?, ?, 'member', ?)`,
		)
		.bind(acmeId, people.ann.stableUserId, now)
		.run()
	const storeKey = async (input: {
		ownerId?: OwnerId
		name: string
		value?: string
		provider?: string | null
		hosts?: Array<string>
		inject?: unknown
	}) => {
		const ownerId = input.ownerId ?? acmeId
		await saveSecret({
			env,
			userId: ownerId,
			scope: 'user',
			name: input.name,
			value: input.value ?? resendKey,
			audit: null,
		})
		const row = await db
			.prepare(
				`UPDATE secret_entries
				SET kind = 'secret', provider = ?, allowed_hosts = ?, inject_json = ?
				WHERE name = ? AND bucket_id IN (
					SELECT id FROM secret_buckets WHERE user_id = ? AND scope = 'user'
				)
				RETURNING id`,
			)
			.bind(
				input.provider === undefined ? 'resend' : input.provider,
				JSON.stringify(input.hosts ?? ['api.resend.com']),
				JSON.stringify(
					input.inject ?? {
						kind: 'header',
						name: 'Authorization',
						format: 'Bearer {value}',
					},
				),
				input.name,
				ownerId,
			)
			.first<{ id: string }>()
		return row!.id
	}
	const savePackage = async (input: { ownerId: OwnerId; name: string }) => {
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
				created_at: now,
				updated_at: now,
			},
			null,
			{ stamp: false },
		)
		return packageId
	}
	const requestAs = (
		person: keyof typeof people,
		role: OrgRole | null,
		orgId: OwnerId = acmeId,
	) =>
		deriveRequestContext({
			user: { userId: people[person].personId, username: person },
			source: { kind: 'mcp-oauth' },
			orgBinding: { org: { id: orgId, slug: 'acme-clients' }, role },
		})
	const contextFor = (input: {
		request: ReturnType<typeof requestAs>
		packageId?: string | null
		binding?: string
		credentials?: CredentialCallMapInput
	}): CredentialClientContext => ({
		env,
		callerContext: {
			baseUrl: 'https://example.com',
			request: input.request,
			user: null,
		} as unknown as McpCallerContext,
		binding: input.binding ?? 'run:test',
		packageId: input.packageId ?? null,
		callMap: normalizeCredentialCallMap(input.credentials),
	})
	const grantUse = (credentialId: string, person: keyof typeof people) =>
		upsertGrant({
			db,
			orgId: acmeId,
			resourceType: 'credential',
			resourceId: credentialId,
			family: 'secret',
			subject: { type: 'user', id: people[person].stableUserId },
			preset: 'use',
			permissions: null,
			createdByUserId: people.bea.stableUserId,
			audit: createTestOrgAuditWriter(),
		})
	const audits = async () => {
		await Promise.all(scheduledAudits.splice(0))
		const { results } = await auditDb
			.prepare(
				`SELECT result, details_json FROM org_audit_events
				 WHERE action = 'credential.resolve' ORDER BY rowid`,
			)
			.all<{ result: string; details_json: string }>()
		return results
	}
	scheduledAudits.length = 0
	return {
		db,
		auditDb,
		env,
		people,
		acmeId,
		storeKey,
		savePackage,
		requestAs,
		contextFor,
		grantUse,
		audits,
	}
}

function mockNeeds(needs: Array<Partial<CredentialNeed> & { key: string }>) {
	return vi
		.spyOn(needsClosure, 'loadPublishedCredentialNeeds')
		.mockResolvedValue(
			needs.map((need) => ({
				kind: 'secret',
				provider: need.key,
				description: '',
				multiple: false,
				...need,
			})),
		)
}

async function rejection(promise: Promise<unknown>) {
	return await promise.then(
		() => {
			throw new Error('Expected a rejection.')
		},
		(error: unknown) => error as Error & { body?: unknown },
	)
}

test('a client opens by key with no value, and the gateway places the key by its inject on its hosts only', async () => {
	const t = await setup()
	await t.storeKey({
		name: 'resend-prod',
		inject: { kind: 'header', name: 'X-Api-Key', format: '{value}' },
	})
	const request = t.requestAs('bea', 'owner')
	const opened = await openCredentialClient(t.contextFor({ request }), {
		key: 'resend',
	})
	expect(opened).toMatchObject({
		key: 'resend',
		name: 'resend-prod',
		scope: 'org',
		kind: 'secret',
		hosts: ['api.resend.com'],
	})
	expect(opened.handle).toMatch(/^kch1\./)
	expect(JSON.stringify(opened)).not.toContain(resendKey)

	const apply = (url: string, binding = 'run:test') =>
		applyCredentialClient({
			env: t.env,
			request,
			baseUrl: 'https://example.com',
			packageId: null,
			binding,
			token: opened.handle,
			requestUrl: new URL(url),
		})
	const applied = await apply('https://api.resend.com/emails')
	expect(applied.placement).toEqual({
		kind: 'header',
		name: 'X-Api-Key',
		value: resendKey,
	})
	expect(applied.substitutedValues).toContain(resendKey)

	await expect(apply('https://attacker.example/collect')).rejects.toMatchObject(
		{ body: { code: 'host_not_allowed' } },
	)
	await expect(apply('http://api.resend.com/emails')).rejects.toMatchObject({
		body: { code: 'insecure_transport' },
	})
	// A handle works only in the run that opened it.
	await expect(
		apply('https://api.resend.com/emails', newRunCredentialClientBinding()),
	).rejects.toMatchObject({ body: { code: 'invalid_request' } })

	const rows = await t.audits()
	expect(rows.map((row) => row.result)).toEqual(['success', 'denied', 'denied'])
	expect(JSON.stringify(rows)).not.toContain(resendKey)
})

test('basic and query injects place the value without exposing it', async () => {
	const t = await setup()
	await t.storeKey({
		name: 'basic-key',
		provider: 'basicco',
		hosts: ['api.basic.example'],
		inject: { kind: 'basic', valueAs: 'username', other: '' },
	})
	await t.storeKey({
		name: 'query-key',
		provider: 'queryco',
		hosts: ['api.query.example'],
		inject: { kind: 'query', param: 'api_key' },
	})
	const request = t.requestAs('bea', 'owner')
	const ctx = t.contextFor({ request })
	const applyFor = async (key: string, url: string) =>
		applyCredentialClient({
			env: t.env,
			request,
			baseUrl: 'https://example.com',
			packageId: null,
			binding: 'run:test',
			token: (await openCredentialClient(ctx, { key })).handle,
			requestUrl: new URL(url),
		})
	const basic = await applyFor('basicco', 'https://api.basic.example/v1')
	expect(basic.placement).toEqual({
		kind: 'header',
		name: 'Authorization',
		value: `Basic ${btoa(`${resendKey}:`)}`,
	})
	const query = await applyFor('queryco', 'https://api.query.example/v1?x=1')
	expect(query.placement).toEqual({
		kind: 'query',
		param: 'api_key',
		value: resendKey,
	})
})

test('open reports unbound and ambiguous picks with ready-to-retry options, listing only usable credentials', async () => {
	const t = await setup()
	const bea = t.contextFor({ request: t.requestAs('bea', 'owner') })
	await expect(
		rejection(openCredentialClient(bea, { key: 'resend' })),
	).resolves.toMatchObject({
		body: { code: 'credential_unbound', retryWith: [] },
	})

	const firstId = await t.storeKey({ name: 'resend-a' })
	await t.storeKey({ name: 'resend-b' })
	const ambiguous = await rejection(
		openCredentialClient(bea, { key: 'resend' }),
	)
	expect(ambiguous.body).toMatchObject({
		code: 'credential_ambiguous',
		retryWith: [
			{
				credentials: { resend: { name: 'resend-a', scope: 'org' } },
				named: { name: 'resend-a', scope: 'org' },
			},
			{
				credentials: { resend: { name: 'resend-b', scope: 'org' } },
				named: { name: 'resend-b', scope: 'org' },
			},
		],
		options: [
			expect.objectContaining({ name: 'resend-a', kind: 'secret' }),
			expect.objectContaining({ name: 'resend-b', kind: 'secret' }),
		],
	})

	// Ann has no Use, so neither credential is a candidate for her.
	const ann = t.contextFor({ request: t.requestAs('ann', 'member') })
	await expect(
		rejection(openCredentialClient(ann, { key: 'resend' })),
	).resolves.toMatchObject({ body: { code: 'credential_unbound' } })
	await t.grantUse(firstId, 'ann')
	await expect(
		openCredentialClient(
			t.contextFor({ request: t.requestAs('ann', 'member') }),
			{ key: 'resend' },
		),
	).resolves.toMatchObject({ name: 'resend-a' })
})

test('a declared need picks by its kind and provider, and offers same-kind credentials with no provider', async () => {
	const t = await setup()
	const packageId = await t.savePackage({
		ownerId: t.acmeId,
		name: '@acme/mailer',
	})
	mockNeeds([{ key: 'MAIL', provider: 'resend' }])
	await t.storeKey({ name: 'loose-key', provider: null })
	const ctx = t.contextFor({
		request: t.requestAs('bea', 'owner'),
		packageId,
	})
	const unbound = await rejection(openCredentialClient(ctx, { key: 'MAIL' }))
	expect(unbound.body).toMatchObject({
		code: 'credential_unbound',
		retryWith: [
			{
				credentials: { MAIL: { name: 'loose-key', scope: 'org' } },
				named: { name: 'loose-key', scope: 'org' },
			},
		],
		possibleMatches: [expect.objectContaining({ name: 'loose-key' })],
	})
	await t.storeKey({ name: 'resend-prod' })
	await expect(
		openCredentialClient(ctx, { key: 'MAIL' }),
	).resolves.toMatchObject({ key: 'MAIL', name: 'resend-prod' })
})

test('unbound and not-found errors always carry a creation link for the bound org, locking a declared kind', async () => {
	const t = await setup()
	const bea = t.requestAs('bea', 'owner')
	const adHoc = await rejection(
		openCredentialClient(t.contextFor({ request: bea }), { key: 'resend' }),
	)
	const adHocUrl =
		'https://example.com/@acme-clients/-/credentials/new?kind=secret&name=resend&provider=resend'
	expect(adHoc.body).toMatchObject({
		code: 'credential_unbound',
		createUrl: adHocUrl,
	})

	const packageId = await t.savePackage({
		ownerId: t.acmeId,
		name: '@acme/digest',
	})
	mockNeeds([
		{
			key: 'github',
			kind: 'oauth',
			description: 'Read PRs to summarize them',
		},
	])
	const declared = await rejection(
		openCredentialClient(t.contextFor({ request: bea, packageId }), {
			key: 'github',
		}),
	)
	const declaredUrl = new URL(
		(declared.body as { createUrl: string }).createUrl,
	)
	expect(declaredUrl.pathname).toBe('/@acme-clients/-/credentials/new')
	expect(Object.fromEntries(declaredUrl.searchParams)).toEqual({
		kind: 'oauth',
		kindMode: 'required',
		name: 'github',
		provider: 'github',
		description: 'Read PRs to summarize them',
		forPackage: expect.any(String),
		need: 'github',
	})

	const named = await rejection(
		openCredentialClient(t.contextFor({ request: bea }), { name: 'missing' }),
	)
	expect(named.body).toMatchObject({
		code: 'credential_not_found',
		createUrl:
			'https://example.com/@acme-clients/-/credentials/new?name=missing',
	})
})

test('a declared need with no kind opens any fetch-capable credential for the provider', async () => {
	const t = await setup()
	const packageId = await t.savePackage({
		ownerId: t.acmeId,
		name: '@acme/pr-summary',
	})
	vi.spyOn(needsClosure, 'loadPublishedCredentialNeeds').mockResolvedValue([
		{
			key: 'github',
			provider: 'github',
			description: 'Read PRs to summarize them',
			multiple: false,
		},
	])
	await t.storeKey({
		name: 'gh-pat',
		provider: 'github',
		hosts: ['api.github.com'],
	})
	const ctx = t.contextFor({
		request: t.requestAs('bea', 'owner'),
		packageId,
	})
	await expect(
		openCredentialClient(ctx, { key: 'github' }),
	).resolves.toMatchObject({
		key: 'github',
		name: 'gh-pat',
		kind: 'secret',
	})

	vi.spyOn(needsClosure, 'loadPublishedCredentialNeeds').mockResolvedValue([
		{
			key: 'github',
			kind: 'oauth',
			provider: 'github',
			description: 'OAuth only',
			multiple: false,
		},
	])
	await expect(
		rejection(openCredentialClient(ctx, { key: 'github' })),
	).resolves.toMatchObject({ body: { code: 'credential_unbound' } })
})

test('credential.named works in ad hoc code and unshared personal packages only', async () => {
	const t = await setup()
	await t.storeKey({ name: 'resend-prod' })
	const bea = t.requestAs('bea', 'owner')
	await expect(
		openCredentialClient(t.contextFor({ request: bea }), {
			name: 'resend-prod',
			scope: 'org',
		}),
	).resolves.toMatchObject({ key: null, name: 'resend-prod' })
	await expect(
		rejection(
			openCredentialClient(t.contextFor({ request: bea }), {
				name: 'missing',
			}),
		),
	).resolves.toMatchObject({ body: { code: 'credential_not_found' } })

	const orgPackageId = await t.savePackage({
		ownerId: t.acmeId,
		name: '@acme/tool',
	})
	await expect(
		rejection(
			openCredentialClient(
				t.contextFor({ request: bea, packageId: orgPackageId }),
				{ name: 'resend-prod' },
			),
		),
	).resolves.toMatchObject({ body: { code: 'credential_denied' } })

	const beaOrgId = personalOrgId(t.people.bea.personId)
	await t.storeKey({ ownerId: beaOrgId, name: 'my-key' })
	const personalPackageId = await t.savePackage({
		ownerId: beaOrgId,
		name: '@bea/tool',
	})
	const inPersonal = t.contextFor({
		request: t.requestAs('bea', 'owner', beaOrgId),
		packageId: personalPackageId,
	})
	await expect(
		openCredentialClient(inPersonal, { name: 'my-key' }),
	).resolves.toMatchObject({ name: 'my-key' })
	await t.db
		.prepare(
			`INSERT INTO community_listings
			 (id, owner_user_id, package_id, source_id, kody_id, name, description, license, pinned_commit)
			 VALUES (?, ?, ?, ?, 'tool', '@bea/tool', 'tool', 'MIT', 'abc')`,
		)
		.bind(
			crypto.randomUUID(),
			beaOrgId,
			personalPackageId,
			`source-${personalPackageId}`,
		)
		.run()
	await expect(
		rejection(openCredentialClient(inPersonal, { name: 'my-key' })),
	).resolves.toMatchObject({ body: { code: 'credential_denied' } })
})

test('a handle is refused when forged, expired, or used by another actor', async () => {
	const t = await setup()
	const id = await t.storeKey({ name: 'resend-prod' })
	await t.grantUse(id, 'ann')
	const bea = t.requestAs('bea', 'owner')
	const ann = t.requestAs('ann', 'member')
	const opened = await openCredentialClient(t.contextFor({ request: bea }), {
		key: 'resend',
	})
	const applyAs = (request: typeof bea, token: string) =>
		applyCredentialClient({
			env: t.env,
			request,
			baseUrl: 'https://example.com',
			packageId: null,
			binding: 'run:test',
			token,
			requestUrl: new URL('https://api.resend.com/emails'),
		})
	await expect(applyAs(ann, opened.handle)).rejects.toMatchObject({
		body: { code: 'invalid_request' },
	})
	const [prefix, body] = opened.handle.split('.')
	await expect(
		applyAs(bea, `${prefix}.${body}.${'A'.repeat(43)}`),
	).rejects.toMatchObject({ body: { code: 'invalid_request' } })
	const expired = await signCredentialClientHandle({
		env: t.env,
		handle: {
			id,
			kind: 'secret',
			name: 'resend-prod',
			scope: 'org',
			org: t.acmeId,
			actor: t.people.bea.personId,
			binding: 'run:test',
		},
		now: Date.now() - 13 * 60 * 60 * 1000,
	})
	await expect(applyAs(bea, expired)).rejects.toMatchObject({
		body: { code: 'invalid_request' },
	})
})

test('the gateway strips the handle, places the key, holds redirects, redacts echoes, and hints the shape on a 401', async () => {
	const t = await setup()
	await t.storeKey({ name: 'resend-prod' })
	vi.spyOn(usageModule, 'recordUsage').mockResolvedValue(undefined)
	const request = t.requestAs('bea', 'owner')
	const opened = await openCredentialClient(t.contextFor({ request }), {
		key: 'resend',
	})
	const seen: Array<Request> = []
	const globalFetch = vi.fn(async (outbound: Request) => {
		seen.push(outbound)
		return new Response(`echo ${outbound.headers.get('authorization')}`, {
			status: 401,
		})
	})
	const response = await executeGatewayFetch({
		env: t.env,
		props: {
			baseUrl: 'https://example.com',
			userId: t.acmeId,
			email: 'bea@example.com',
			request,
			storageContext: null,
			credentialClientBinding: 'run:test',
		},
		request: new Request('https://api.resend.com/emails', {
			headers: {
				[credentialClientHeaderName]: opened.handle,
				Authorization: 'Bearer code-set-value',
			},
		}),
		globalFetch: globalFetch as unknown as typeof fetch,
	})
	const [outbound] = seen
	expect(outbound?.headers.get('authorization')).toBe(`Bearer ${resendKey}`)
	expect(outbound?.headers.has(credentialClientHeaderName)).toBe(false)
	expect(outbound?.redirect).toBe('manual')
	expect(response.status).toBe(401)
	expect(response.headers.get(credentialClientHintHeaderName)).toBe(
		'header Authorization Bearer',
	)
	const text = await response.text()
	expect(text).not.toContain(resendKey)

	// Without a binding (no run), a client fetch is refused before any send.
	seen.length = 0
	await expect(
		executeGatewayFetch({
			env: t.env,
			props: {
				baseUrl: 'https://example.com',
				userId: t.acmeId,
				email: 'bea@example.com',
				request,
				storageContext: null,
			},
			request: new Request('https://api.resend.com/emails', {
				headers: { [credentialClientHeaderName]: opened.handle },
			}),
			globalFetch: globalFetch as unknown as typeof fetch,
		}),
	).rejects.toMatchObject({ body: { code: 'invalid_request' } })
	expect(seen).toHaveLength(0)
})

test('the placed header drops the code value before placeholders expand, so a placeholder there never resolves', async () => {
	const t = await setup()
	await t.storeKey({ name: 'resend-prod' })
	vi.spyOn(usageModule, 'recordUsage').mockResolvedValue(undefined)
	const request = t.requestAs('bea', 'owner')
	const opened = await openCredentialClient(t.contextFor({ request }), {
		key: 'resend',
	})
	const seen: Array<Request> = []
	const response = await executeGatewayFetch({
		env: t.env,
		props: {
			baseUrl: 'https://example.com',
			userId: t.acmeId,
			email: 'bea@example.com',
			request,
			storageContext: null,
			credentialClientBinding: 'run:test',
		},
		request: new Request('https://api.resend.com/emails', {
			headers: {
				[credentialClientHeaderName]: opened.handle,
				Authorization: 'Bearer {{secret:no-such-secret}}',
			},
		}),
		globalFetch: (async (outbound: Request) => {
			seen.push(outbound)
			return new Response('ok')
		}) as unknown as typeof fetch,
	})
	expect(response.status).toBe(200)
	expect(seen[0]?.headers.get('authorization')).toBe(`Bearer ${resendKey}`)
})

test('stored mappings pick the credential: trigger override, then your default, then the org default, then auto-resolve', async () => {
	const t = await setup()
	const keyA = await t.storeKey({ name: 'resend-a' })
	const keyB = await t.storeKey({ name: 'resend-b' })
	await t.grantUse(keyA, 'ann')
	const packageId = await t.savePackage({
		ownerId: t.acmeId,
		name: '@acme-clients/digest',
	})
	mockNeeds([{ key: 'resend' }])
	const map = (
		target: CredentialMappingRowTarget,
		credentialIds: Array<string> | null,
	) =>
		runCredentialMappingWrite(
			t.db,
			buildWriteCredentialMappingStatement({
				db: t.db,
				orgId: t.acmeId,
				packageId,
				needKey: 'resend',
				target,
				credentialIds,
				updatedByUserId: t.people.bea.personId,
				now,
			}),
		)
	const open = (request: ReturnType<typeof t.requestAs>) =>
		openCredentialClient(t.contextFor({ request, packageId }), {
			key: 'resend',
		})
	const bea = t.requestAs('bea', 'owner')
	const ann = t.requestAs('ann', 'member')

	await expect(open(bea)).rejects.toMatchObject({
		body: { code: 'credential_ambiguous' },
	})
	await map({ target: 'org' }, [keyB])
	await expect(open(bea)).resolves.toMatchObject({ name: 'resend-b' })
	await map({ target: 'mine', personId: t.people.bea.personId }, [keyA])
	await expect(open(bea)).resolves.toMatchObject({ name: 'resend-a' })
	await map({ target: 'mine', personId: t.people.bea.personId }, [])
	const none = await rejection(open(bea))
	expect(none.body).toMatchObject({
		code: 'credential_unbound',
		createUrl: expect.stringContaining('/@acme-clients/-/credentials/new?'),
	})
	expect(none.message).toContain('mapped to no credential on purpose')

	// Ann cannot Use the org default, so it is skipped and her one usable Key
	// auto-resolves. Bea's own default never applies to Ann.
	await expect(open(ann)).resolves.toMatchObject({ name: 'resend-a' })

	// A trigger run acts as its enabler and its override never falls through.
	const enablementId = 'enablement-ann-daily'
	const annTrigger = deriveRequestContext({
		user: { userId: t.people.ann.personId },
		source: {
			kind: 'schedule',
			jobId: 'job-1',
			enablement: {
				id: enablementId,
				enabler: { userId: t.people.ann.personId },
				role: 'member',
			},
		},
		orgBinding: { org: { id: t.acmeId, slug: 'acme-clients' }, role: null },
	})
	const trigger = {
		target: 'enablement',
		enablementId,
		personId: t.people.ann.personId,
	} as const
	await map(trigger, [keyB])
	const unusable = await rejection(open(annTrigger))
	expect(unusable.body).toMatchObject({
		code: 'credential_not_found',
		createUrl: expect.stringContaining('/@acme-clients/-/credentials/new?'),
	})
	await expect(open(ann)).resolves.toMatchObject({ name: 'resend-a' })
	await map(trigger, [keyA])
	await expect(open(annTrigger)).resolves.toMatchObject({ name: 'resend-a' })
	await map(trigger, [])
	await expect(open(annTrigger)).rejects.toMatchObject({
		body: { code: 'credential_unbound' },
	})
	await map(trigger, null)
	await expect(open(annTrigger)).resolves.toMatchObject({ name: 'resend-a' })

	// Leaving the org drops Ann's own mappings, not the org default.
	expect(
		await deleteCredentialMappingsForMember({
			db: t.db,
			orgId: t.acmeId,
			personId: t.people.ann.personId,
		}),
	).toBe(0)
	await map(trigger, [keyA])
	expect(
		await deleteCredentialMappingsForMember({
			db: t.db,
			orgId: t.acmeId,
			personId: t.people.ann.personId,
		}),
	).toBe(1)
	await expect(open(bea)).rejects.toMatchObject({
		body: { code: 'credential_unbound' },
	})
})

test('a need a republish added fails only that call in a trigger run, with an org-scoped creation link', async () => {
	const t = await setup()
	await t.storeKey({ name: 'resend-prod' })
	const packageId = await t.savePackage({
		ownerId: t.acmeId,
		name: '@acme/digest',
	})
	const beaTrigger = deriveRequestContext({
		user: { userId: t.people.bea.personId },
		source: {
			kind: 'schedule',
			jobId: 'job-1',
			enablement: {
				id: 'enablement-bea-daily',
				enabler: { userId: t.people.bea.personId },
				role: 'owner',
			},
		},
		orgBinding: { org: { id: t.acmeId, slug: 'acme-clients' }, role: 'owner' },
	})
	const open = (key: string) =>
		openCredentialClient(t.contextFor({ request: beaTrigger, packageId }), {
			key,
		})
	mockNeeds([{ key: 'mail', provider: 'resend' }])
	await expect(open('mail')).resolves.toMatchObject({ name: 'resend-prod' })

	mockNeeds([
		{ key: 'mail', provider: 'resend' },
		{ key: 'chat', provider: 'slack' },
	])
	const unbound = await rejection(open('chat'))
	const unboundUrl = new URL((unbound.body as { createUrl: string }).createUrl)
	expect(unbound.body).toMatchObject({ code: 'credential_unbound' })
	expect(unboundUrl.pathname).toBe('/@acme-clients/-/credentials/new')
	expect(unboundUrl.searchParams.get('need')).toBe('chat')
	expect(unbound.message).toContain(`Create one at ${unboundUrl.href}`)
	// The rest of the trigger keeps working.
	await expect(open('mail')).resolves.toMatchObject({ name: 'resend-prod' })

	await t.storeKey({ name: 'slack-a', provider: 'slack' })
	await t.storeKey({ name: 'slack-b', provider: 'slack' })
	const ambiguous = await rejection(open('chat'))
	expect(ambiguous.body).toMatchObject({
		code: 'credential_ambiguous',
		options: [
			expect.objectContaining({ name: 'slack-a' }),
			expect.objectContaining({ name: 'slack-b' }),
		],
	})
	expect(
		new URL((ambiguous.body as { createUrl: string }).createUrl).pathname,
	).toBe('/@acme-clients/-/credentials/new')
	await expect(open('mail')).resolves.toMatchObject({ name: 'resend-prod' })
})

test('a stored mapping stops applying when the need changes or is removed, and a corrupt row reads as unset', async () => {
	const t = await setup()
	const keyA = await t.storeKey({ name: 'resend-a' })
	await t.db
		.prepare(
			`INSERT INTO mcp_server_settings (id, user_id, name, url, provider, enabled)
			 VALUES ('mcp-resend', ?, 'resend-mcp', 'https://mcp.resend.example/sse', 'resend', 1)`,
		)
		.bind(t.acmeId)
		.run()
	const packageId = await t.savePackage({
		ownerId: t.acmeId,
		name: '@acme-clients/digest',
	})
	const mapOrg = (credentialIds: Array<string>) =>
		runCredentialMappingWrite(
			t.db,
			buildWriteCredentialMappingStatement({
				db: t.db,
				orgId: t.acmeId,
				packageId,
				needKey: 'resend',
				target: { target: 'org' },
				credentialIds,
				updatedByUserId: t.people.bea.personId,
				now,
			}),
		)
	const open = () =>
		openCredentialClient(
			t.contextFor({ request: t.requestAs('bea', 'owner'), packageId }),
			{ key: 'resend' },
		)

	mockNeeds([{ key: 'resend' }])
	await mapOrg([keyA])
	await expect(open()).resolves.toMatchObject({ name: 'resend-a' })
	mockNeeds([{ key: 'resend', provider: 'postmark' }])
	await expect(open()).rejects.toMatchObject({
		body: { code: 'credential_unbound' },
	})

	mockNeeds([{ key: 'resend', kind: undefined }])
	await mapOrg(['mcp-resend'])
	await expect(open()).resolves.toMatchObject({
		name: 'resend-a',
		kind: 'secret',
	})

	await mapOrg([])
	await t.db
		.prepare(`UPDATE credential_mappings SET credential_ids_json = '{bad'`)
		.run()
	consoleError.mockImplementation(() => {})
	await expect(open()).resolves.toMatchObject({ name: 'resend-a' })
	expect(consoleError).toHaveBeenCalledWith(
		expect.stringContaining('corrupt credential ids'),
	)

	await mapOrg([])
	await expect(open()).rejects.toMatchObject({
		body: { code: 'credential_unbound' },
	})
	// Removed need: the leftover row is ignored and the key auto-resolves.
	mockNeeds([])
	await expect(open()).rejects.toMatchObject({
		body: { code: 'credential_ambiguous' },
	})

	expect(
		await deleteCredentialMappingsForPackage({
			db: t.db,
			orgId: t.acmeId,
			packageId,
		}),
	).toBe(1)
})

test('a call map pick wins over a stored mapping, and credentials() opens every mapped credential', async () => {
	const t = await setup()
	const keyA = await t.storeKey({ name: 'resend-a' })
	const keyB = await t.storeKey({ name: 'resend-b' })
	const packageId = await t.savePackage({
		ownerId: t.acmeId,
		name: '@acme-clients/digest',
	})
	mockNeeds([{ key: 'resend' }])
	await runCredentialMappingWrite(
		t.db,
		buildWriteCredentialMappingStatement({
			db: t.db,
			orgId: t.acmeId,
			packageId,
			needKey: 'resend',
			target: { target: 'org' },
			credentialIds: [keyA, keyB],
			updatedByUserId: t.people.bea.personId,
			now,
		}),
	)
	const request = t.requestAs('bea', 'owner')
	await expect(
		openCredentialClient(t.contextFor({ request, packageId }), {
			key: 'resend',
		}),
	).resolves.toMatchObject({ name: 'resend-a' })
	await expect(
		openCredentialClient(
			t.contextFor({ request, packageId, credentials: { resend: 'resend-b' } }),
			{ key: 'resend' },
		),
	).resolves.toMatchObject({ name: 'resend-b' })
	const all = await openCredentialClients(
		t.contextFor({ request, packageId }),
		{
			key: 'resend',
		},
	)
	expect(all.map((client) => client.name)).toEqual(['resend-a', 'resend-b'])
})

test('a call map picks by name among several matches, and credentials() opens every pick', async () => {
	const t = await setup()
	await t.storeKey({ name: 'resend-a' })
	await t.storeKey({ name: 'resend-b' })
	const request = t.requestAs('bea', 'owner')
	await expect(
		rejection(
			openCredentialClient(t.contextFor({ request }), { key: 'resend' }),
		),
	).resolves.toMatchObject({ body: { code: 'credential_ambiguous' } })

	const picked = await openCredentialClient(
		t.contextFor({ request, credentials: { resend: 'resend-b' } }),
		{ key: 'resend' },
	)
	expect(picked).toMatchObject({
		name: 'resend-b',
		scope: 'org',
		key: 'resend',
	})
	expect(picked.hint).toBeUndefined()

	const both = t.contextFor({
		request,
		credentials: { resend: ['resend-a', { name: 'resend-b', scope: 'org' }] },
	})
	const many = await openCredentialClients(both, { key: 'resend' })
	expect(many.map((client) => client.name)).toEqual(['resend-a', 'resend-b'])
	await expect(
		rejection(openCredentialClient(both, { key: 'resend' })),
	).resolves.toMatchObject({
		body: {
			code: 'invalid_request',
			message:
				'The credentials map picks 2 credentials for "resend": "resend-a" (org), "resend-b" (org). Pick one of them for credential("resend"), or call credentials("resend") to get all of them.',
			retryWith: [
				expect.objectContaining({
					credentials: { resend: { name: 'resend-a', scope: 'org' } },
				}),
				expect.objectContaining({
					credentials: { resend: { name: 'resend-b', scope: 'org' } },
				}),
			],
			options: [
				expect.objectContaining({ name: 'resend-a', scope: 'org' }),
				expect.objectContaining({ name: 'resend-b', scope: 'org' }),
			],
		},
	})

	const none = t.contextFor({ request, credentials: { resend: [] } })
	expect(await openCredentialClients(none, { key: 'resend' })).toEqual([])
	await expect(
		rejection(openCredentialClient(none, { key: 'resend' })),
	).resolves.toMatchObject({ body: { code: 'credential_unbound' } })

	// No map entry: a multiple need still gets only the one match.
	await t.storeKey({ name: 'solo', provider: 'solo' })
	const solo = await openCredentialClients(t.contextFor({ request }), {
		key: 'solo',
	})
	expect(solo.map((client) => client.name)).toEqual(['solo'])
})

test('a call map pick must match the need kind and provider, and a pick with no provider carries a hint', async () => {
	const t = await setup()
	await t.storeKey({ name: 'resend-prod' })
	await t.storeKey({ name: 'loose-key', provider: null })
	await t.storeKey({ name: 'github-key', provider: 'github' })
	const request = t.requestAs('bea', 'owner')
	const packageId = await t.savePackage({ ownerId: t.acmeId, name: '@acme/m' })
	mockNeeds([
		{ key: 'MAIL', provider: 'resend' },
		{ key: 'HOOK', kind: 'url', provider: 'hooks' },
	])
	const open = (key: string, credentials: CredentialCallMapInput) =>
		openCredentialClient(t.contextFor({ request, packageId, credentials }), {
			key,
		})
	await expect(
		rejection(open('MAIL', { MAIL: 'github-key' })),
	).resolves.toMatchObject({
		body: { code: 'invalid_request' },
	})
	await expect(
		rejection(open('HOOK', { HOOK: 'resend-prod' })),
	).resolves.toMatchObject({
		body: { code: 'invalid_request' },
	})
	await expect(
		rejection(open('MAIL', { MAIL: 'nope' })),
	).resolves.toMatchObject({ body: { code: 'credential_not_found' } })
	const loose = await open('MAIL', { MAIL: 'loose-key' })
	expect(loose.name).toBe('loose-key')
	expect(JSON.stringify(loose)).not.toContain(resendKey)
})

test('a call map is validated before code runs: unknown keys fail an invoke and warn ad hoc code', async () => {
	const t = await setup()
	await t.storeKey({ name: 'resend-prod' })
	const request = t.requestAs('bea', 'owner')
	const packageId = await t.savePackage({ ownerId: t.acmeId, name: '@acme/m' })
	mockNeeds([{ key: 'MAIL', provider: 'resend' }])
	const validate = (
		credentials: CredentialCallMapInput,
		strict: boolean,
		packageIds: Array<string> = [packageId],
	) =>
		validateCredentialCallMap({
			env: t.env,
			request,
			map: normalizeCredentialCallMap(credentials)!,
			packageIds,
			strict,
			baseUrl: 'https://example.com',
		})
	await expect(validate({ MAIL: 'resend-prod' }, true)).resolves.toEqual({
		warnings: [],
	})
	await expect(
		rejection(validate({ MAIL: 'resend-prod', OTHER: 'resend-prod' }, true)),
	).resolves.toMatchObject({
		body: { code: 'credential_need_unknown', retryWith: [] },
	})
	const adHoc = await validate({ resend: 'resend-prod' }, false, [])
	expect(adHoc.warnings).toEqual([
		expect.stringContaining('credentials.resend is not a need of this code'),
	])
	const missing = await rejection(validate({ MAIL: 'missing' }, true))
	expect(missing.body).toMatchObject({ code: 'credential_not_found' })
	expect(
		Object.fromEntries(
			new URL((missing.body as { createUrl: string }).createUrl).searchParams,
		),
	).toEqual({
		kind: 'secret',
		kindMode: 'required',
		name: 'missing',
	})
	const emptyPick = await rejection(
		openCredentialClient(
			t.contextFor({ request, packageId, credentials: { MAIL: [] } }),
			{ key: 'MAIL' },
		),
	)
	expect(emptyPick.body).toMatchObject({
		code: 'credential_unbound',
		createUrl: expect.stringContaining('need=MAIL'),
	})
	await expect(
		rejection(
			validateCredentialCallMap({
				env: t.env,
				request: null,
				map: normalizeCredentialCallMap({ MAIL: 'resend-prod' })!,
				packageIds: [],
				strict: false,
				baseUrl: 'https://example.com',
			}),
		),
	).resolves.toMatchObject({ body: { code: 'credential_denied' } })
})

test('call map validation keeps the entry package pinned needs over a dependency later publish', async () => {
	const t = await setup()
	await t.storeKey({ name: 'resend-prod' })
	const request = t.requestAs('bea', 'owner')
	const entryId = await t.savePackage({
		ownerId: t.acmeId,
		name: '@acme/entry',
	})
	const depId = await t.savePackage({ ownerId: t.acmeId, name: '@acme/mailer' })
	const need = (provider: string): CredentialNeed => ({
		key: 'MAIL',
		kind: 'secret',
		provider,
		description: '',
		multiple: false,
	})
	vi.spyOn(needsClosure, 'loadPublishedCredentialNeeds')
		.mockResolvedValueOnce([need('resend')])
		.mockResolvedValueOnce([need('postmark')])
	await expect(
		validateCredentialCallMap({
			env: t.env,
			request,
			map: normalizeCredentialCallMap({ MAIL: 'resend-prod' })!,
			packageIds: [entryId, depId],
			strict: true,
			baseUrl: 'https://example.com',
		}),
	).resolves.toEqual({ warnings: [] })
})

test('a dependency opens against the entry package pinned need its picks passed, not its later publish', async () => {
	const t = await setup()
	await t.storeKey({ name: 'resend-prod' })
	const request = t.requestAs('bea', 'owner')
	const entryId = await t.savePackage({
		ownerId: t.acmeId,
		name: '@acme/entry',
	})
	const depId = await t.savePackage({ ownerId: t.acmeId, name: '@acme/mailer' })
	const need = (provider: string): CredentialNeed => ({
		key: 'MAIL',
		kind: 'secret',
		provider,
		description: '',
		multiple: false,
	})
	vi.spyOn(needsClosure, 'loadPublishedCredentialNeeds').mockImplementation(
		async ({ sourceId }) =>
			sourceId === `source-${entryId}`
				? [need('resend')]
				: [need('postmark'), { ...need('postmark'), key: 'SMS' }],
	)
	const runNeeds = loadRunCredentialNeeds({
		env: t.env,
		orgId: request.org.id,
		packageIds: [entryId],
	})
	const depContext = t.contextFor({
		request,
		packageId: depId,
		credentials: { MAIL: 'resend-prod' },
	})
	const pinned = { ...depContext, runNeeds: () => runNeeds }
	await expect(
		openCredentialClient(pinned, { key: 'MAIL' }),
	).resolves.toMatchObject({ key: 'MAIL', name: 'resend-prod' })
	await expect(
		rejection(openCredentialClient(depContext, { key: 'MAIL' })),
	).resolves.toMatchObject({ body: { code: 'invalid_request' } })
	// SMS is only in the dependency's later publish, so it reads as a
	// provider instead of the dependency's newer need.
	await expect(
		rejection(openCredentialClient(pinned, { key: 'SMS' })),
	).resolves.toMatchObject({
		body: { code: 'credential_unbound' },
	})
	const adHoc = t.contextFor({ request })
	await expect(
		openCredentialClient(
			{ ...adHoc, runNeeds: () => runNeeds },
			{ key: 'MAIL' },
		),
	).resolves.toMatchObject({ key: 'MAIL', name: 'resend-prod' })
	await expect(
		rejection(openCredentialClient(adHoc, { key: 'MAIL' })),
	).resolves.toMatchObject({ body: { code: 'credential_unbound' } })
})

async function setupEntryAndDependency() {
	const t = await setup()
	const keyA = await t.storeKey({ name: 'resend-a' })
	const keyB = await t.storeKey({ name: 'resend-b' })
	const entryId = await t.savePackage({
		ownerId: t.acmeId,
		name: '@acme-clients/storefront',
	})
	const depId = await t.savePackage({
		ownerId: t.acmeId,
		name: '@acme-clients/mail-kit',
	})
	const mail: CredentialNeed = {
		key: 'MAIL',
		kind: 'secret',
		provider: 'resend',
		description: '',
		multiple: false,
	}
	const needsBySource = new Map<string, Array<CredentialNeed>>([
		[`source-${entryId}`, [{ ...mail, from: '@acme-clients/mail-kit' }]],
		[`source-${depId}`, [mail]],
	])
	vi.spyOn(needsClosure, 'loadPublishedCredentialNeeds').mockImplementation(
		async ({ sourceId }) => needsBySource.get(sourceId) ?? [],
	)
	const map = (
		packageId: string,
		target: CredentialMappingRowTarget,
		credentialIds: Array<string> | null,
	) =>
		runCredentialMappingWrite(
			t.db,
			buildWriteCredentialMappingStatement({
				db: t.db,
				orgId: t.acmeId,
				packageId,
				needKey: 'MAIL',
				target,
				credentialIds,
				updatedByUserId: t.people.bea.personId,
				now,
			}),
		)
	const callerContextFor = (request: ReturnType<typeof t.requestAs>) =>
		({
			baseUrl: 'https://example.com',
			request,
			user: { userId: request.actor!.userId },
		}) as unknown as McpCallerContext
	const open = async (
		options: CredentialClientToolOptions,
		request: ReturnType<typeof t.requestAs>,
		args: Record<string, unknown> = {},
	) =>
		(await createCredentialClientKodyTools({
			env: t.env,
			callerContext: callerContextFor(request),
			options,
		})[credentialClientToolNames.open]!({ key: 'MAIL', ...args })) as {
			ok: boolean
			value?: { name: string }
			error?: { code: string; message: string; createUrl?: string }
		}
	return {
		...t,
		keyA,
		keyB,
		entryId,
		depId,
		mail,
		needsBySource,
		map,
		callerContextFor,
		open,
	}
}

test('a dependency credential() reads stored mappings and the creation link from the run entry package', async () => {
	const t = await setupEntryAndDependency()
	const bea = t.requestAs('bea', 'owner')
	const { needs, entries } = await loadRunCredentialNeedEntries({
		env: t.env,
		orgId: t.acmeId,
		packageIds: [t.entryId],
	})
	expect(entries.entryByKey.get('MAIL')).toBe(t.entryId)
	const dependency = (request: ReturnType<typeof t.requestAs>) => ({
		...t.contextFor({ request, packageId: t.depId }),
		runNeeds: async () => needs,
		runEntries: async () => entries,
	})
	const open = (request = bea) =>
		openCredentialClient(dependency(request), { key: 'MAIL' })

	await expect(open()).rejects.toMatchObject({
		body: { code: 'credential_ambiguous' },
	})
	await t.map(t.entryId, { target: 'org' }, [t.keyB])
	await expect(open()).resolves.toMatchObject({ key: 'MAIL', name: 'resend-b' })
	// The dependency's own scope has no mapping, so without the run's entries
	// the same call stays ambiguous.
	await expect(
		openCredentialClient(
			{ ...dependency(bea), runEntries: undefined },
			{ key: 'MAIL' },
		),
	).rejects.toMatchObject({ body: { code: 'credential_ambiguous' } })
	// A mapping stored on the dependency itself never applies to its entry's run.
	await t.map(t.depId, { target: 'org' }, [t.keyA])
	await expect(open()).resolves.toMatchObject({ name: 'resend-b' })
	await t.map(t.entryId, { target: 'mine', personId: t.people.bea.personId }, [
		t.keyA,
	])
	await expect(open()).resolves.toMatchObject({ name: 'resend-a' })
	await t.map(
		t.entryId,
		{ target: 'mine', personId: t.people.bea.personId },
		[],
	)
	const unbound = await rejection(open())
	expect(unbound.body).toMatchObject({ code: 'credential_unbound' })
	const createUrl = new URL((unbound.body as { createUrl: string }).createUrl)
	expect(createUrl.searchParams.get('forPackage')).toBe('storefront')
	expect(createUrl.searchParams.get('need')).toBe('MAIL')

	// A trigger run reads the entry package's enablement mapping too.
	await t.grantUse(t.keyA, 'ann')
	await t.grantUse(t.keyB, 'ann')
	const enablementId = 'enablement-ann-nightly'
	const annTrigger = deriveRequestContext({
		user: { userId: t.people.ann.personId },
		source: {
			kind: 'schedule',
			jobId: 'job-1',
			enablement: {
				id: enablementId,
				enabler: { userId: t.people.ann.personId },
				role: 'member',
			},
		},
		orgBinding: { org: { id: t.acmeId, slug: 'acme-clients' }, role: null },
	})
	const trigger = {
		target: 'enablement',
		enablementId,
		personId: t.people.ann.personId,
	} as const
	await t.map(t.depId, trigger, [t.keyB])
	await t.map(t.entryId, trigger, [t.keyA])
	await expect(open(annTrigger)).resolves.toMatchObject({ name: 'resend-a' })
})

test('with several entries the first that pins the need picks the mapping, an entry caller keeps its own, and ad hoc code reads none', async () => {
	const t = await setupEntryAndDependency()
	const bea = t.requestAs('bea', 'owner')
	const firstId = await t.savePackage({
		ownerId: t.acmeId,
		name: '@acme-clients/newsletter',
	})
	t.needsBySource.set(`source-${firstId}`, [t.mail])
	await t.map(firstId, { target: 'org' }, [t.keyA])
	await t.map(t.entryId, { target: 'org' }, [t.keyB])
	const { needs, entries } = await loadRunCredentialNeedEntries({
		env: t.env,
		orgId: t.acmeId,
		packageIds: [firstId, t.entryId],
	})
	expect(entries.entryByKey.get('MAIL')).toBe(firstId)
	const asPackage = (packageId: string | null) =>
		openCredentialClient(
			{
				...t.contextFor({ request: bea, packageId }),
				runNeeds: async () => needs,
				runEntries: async () => entries,
			},
			{ key: 'MAIL' },
		)
	await expect(asPackage(t.depId)).resolves.toMatchObject({
		name: 'resend-a',
	})
	await expect(asPackage(t.entryId)).resolves.toMatchObject({
		name: 'resend-b',
	})
	await expect(asPackage(null)).rejects.toMatchObject({
		body: { code: 'credential_ambiguous' },
	})
})

test('hosted execute and invoke read the entry mapping for a bound dependency, and its code cannot name another package', async () => {
	const t = await setupEntryAndDependency()
	const bea = t.requestAs('bea', 'owner')
	await t.map(t.entryId, { target: 'org' }, [t.keyB])
	const hosted = (runPackageId: string | null) =>
		createRunCredentialClientToolOptions({
			env: t.env,
			callerContext: t.callerContextFor(bea),
			binding: 'run:test',
			runPackageId,
			entryPackageIds: [t.entryId],
			callMap: null,
		})!
	// Invoke runs the entry package; ad hoc execute imports it, so it is the
	// run's entry either way.
	for (const options of [hosted(t.entryId), hosted(null)]) {
		await expect(
			runWithCurrentSecretAuthority(t.depId, () => t.open(options, bea)),
		).resolves.toMatchObject({ ok: true, value: { name: 'resend-b' } })
		await expect(
			runWithCurrentSecretAuthority(t.depId, () =>
				t.open(options, bea, { packageId: t.entryId }),
			),
		).resolves.toMatchObject({
			ok: false,
			error: {
				code: 'credential_denied',
				message: createCredentialClientOwnerOnlyMessage(t.entryId),
			},
		})
	}
	// The entry's own code reads its mapping; ad hoc code reads none.
	await expect(t.open(hosted(t.entryId), bea)).resolves.toMatchObject({
		ok: true,
		value: { name: 'resend-b' },
	})
	await expect(t.open(hosted(null), bea)).resolves.toMatchObject({
		ok: false,
		error: { code: 'credential_ambiguous' },
	})
})

test('local CapabilityProxy reads the entry mapping from the signed binding, never a claimed id', async () => {
	const t = await setupEntryAndDependency()
	const bea = t.requestAs('bea', 'owner')
	await t.map(t.entryId, { target: 'org' }, [t.keyB])
	const subject = { org: t.acmeId, actor: bea.actor!.userId }
	const options = createCapabilityProxyCredentialClientTools(
		{
			env: t.env,
			callerContext: t.callerContextFor(bea),
		} as unknown as ApiInvocationContext,
		null,
	)!
	const depBinding = await signLocalExecutePackageBinding({
		env: t.env,
		packageId: t.depId,
		subject,
		entryPackageIds: [t.entryId],
	})
	await expect(
		t.open(options, bea, { packageId: depBinding }),
	).resolves.toMatchObject({ ok: true, value: { name: 'resend-b' } })
	// A binding minted without entries keeps the dependency's own scope.
	const legacyBinding = await signLocalExecutePackageBinding({
		env: t.env,
		packageId: t.depId,
		subject,
	})
	await expect(
		t.open(options, bea, { packageId: legacyBinding }),
	).resolves.toMatchObject({
		ok: false,
		error: { code: 'credential_ambiguous' },
	})
	// Bare ids are refused, the entry's included.
	for (const packageId of [t.depId, t.entryId]) {
		await expect(t.open(options, bea, { packageId })).resolves.toMatchObject({
			ok: false,
			error: { code: 'credential_denied' },
		})
	}
})

async function setupVisitorApp(input?: {
	internetVisible?: boolean
	approvedCommit?: string
	approvedBy?: string
	approvedCredentialIds?: (ids: { database: string }) => Array<string>
}) {
	const t = await setup()
	let userRowId = 1
	for (const [username, person] of Object.entries(t.people)) {
		await t.db
			.prepare(
				`INSERT INTO users (id, username, email, password_hash, stable_user_id)
				 VALUES (?, ?, ?, 'x', ?)`,
			)
			.bind(
				userRowId++,
				username,
				`${username}@example.com`,
				person.stableUserId,
			)
			.run()
	}
	const databaseId = await t.storeKey({
		name: 'rooms-db',
		provider: 'database',
		hosts: ['db.example.com'],
	})
	await t.storeKey({ name: 'resend-prod' })
	const packageId = await t.savePackage({
		ownerId: t.acmeId,
		name: '@acme-clients/rooms',
	})
	await t.db
		.prepare(
			`UPDATE saved_packages SET has_app = 1, is_internet_visible = ? WHERE id = ?`,
		)
		.bind(input?.internetVisible === false ? 0 : 1, packageId)
		.run()
	mockNeeds([
		{ key: 'database', provider: 'database', ownerCredentialForVisitors: true },
		{ key: 'resend' },
	])
	const approvedIds = input?.approvedCredentialIds?.({
		database: databaseId,
	}) ?? [databaseId]
	await insertPackageCapabilityApproval(t.db, {
		id: crypto.randomUUID(),
		package_id: packageId,
		owner_user_id: t.acmeId,
		published_commit: input?.approvedCommit ?? 'commit-1',
		fingerprint: 'fingerprint-1',
		capability_set_json: JSON.stringify(
			approvedIds.map((credentialId) => ({
				kind: 'credential',
				credentialId,
				source: 'need',
				needKey: 'database',
				ownerCredentialForVisitors: true,
				hosts: ['db.example.com'],
				via: ['rooms'],
			})),
		),
		dependency_snapshot_json: '{}',
		approved_by_user_id: input?.approvedBy ?? t.people.bea.stableUserId,
		approved_at: now,
	})
	const scope = { orgId: t.acmeId, packageId, publishedCommit: 'commit-1' }
	const runNeeds = loadRunCredentialNeeds({
		env: t.env,
		orgId: t.acmeId,
		packageIds: [packageId],
	})
	const appContext = (
		request: ReturnType<typeof t.requestAs> | null,
	): CredentialClientContext => ({
		env: t.env,
		callerContext: {
			baseUrl: 'https://example.com',
			request,
			user: null,
		} as unknown as McpCallerContext,
		binding: 'run:app',
		packageId,
		runNeeds: () => runNeeds,
		ownerCredentialScope: scope,
	})
	const fetchAs = (
		request: ReturnType<typeof t.requestAs> | null,
		token: string,
		ownerCredentialScope: typeof scope | null = scope,
	) =>
		applyCredentialClient({
			env: t.env,
			request,
			baseUrl: 'https://example.com',
			packageId,
			binding: 'run:app',
			ownerCredentialScope,
			token,
			requestUrl: new URL('https://db.example.com/v1/rooms'),
		})
	const auditRows = async () => {
		await Promise.all(scheduledAudits.splice(0))
		const { results } = await t.auditDb
			.prepare(
				`SELECT result, actor_user_id, details_json FROM org_audit_events
				 WHERE action = 'credential.resolve' ORDER BY rowid`,
			)
			.all<{
				result: string
				actor_user_id: string | null
				details_json: string
			}>()
		return results.map((row) => ({
			result: row.result,
			actorUserId: row.actor_user_id,
			details: JSON.parse(row.details_json) as Record<string, unknown>,
		}))
	}
	return {
		...t,
		databaseId,
		packageId,
		scope,
		appContext,
		fetchAs,
		auditRows,
	}
}

test('an opted-in need on an approved internet-visible app resolves as its approving owner for anyone, and the viewer stays the viewer', async () => {
	const t = await setupVisitorApp()
	const anonymous = t.appContext(null)
	const opened = await openCredentialClient(anonymous, { key: 'database' })
	expect(opened).toMatchObject({
		key: 'database',
		name: 'rooms-db',
		hosts: ['db.example.com'],
	})
	expect(JSON.stringify(opened)).not.toContain(resendKey)
	const placed = await t.fetchAs(null, opened.handle)
	expect(placed.placement).toMatchObject({
		kind: 'header',
		value: `Bearer ${resendKey}`,
	})

	// Needs without the opt-in still resolve only for the viewer.
	await expect(
		rejection(openCredentialClient(anonymous, { key: 'resend' })),
	).resolves.toMatchObject({
		body: { code: 'credential_denied' },
		message: expect.stringContaining('no acting person'),
	})
	await expect(
		rejection(openCredentialClients(anonymous, { key: 'resend' })),
	).resolves.toMatchObject({ body: { code: 'credential_denied' } })
	// The handle works only where the run shares owner credentials.
	await expect(t.fetchAs(null, opened.handle, null)).rejects.toMatchObject({
		body: { code: 'invalid_request' },
	})

	// Ann is a member with no Use on rooms-db; Bea is the approving owner.
	const ann = t.requestAs('ann', 'member')
	const annOpened = await openCredentialClient(t.appContext(ann), {
		key: 'database',
	})
	await t.fetchAs(ann, annOpened.handle)
	await expect(
		openCredentialClients(t.appContext(ann), { key: 'database' }),
	).resolves.toMatchObject([{ name: 'rooms-db' }])
	const bea = t.requestAs('bea', 'owner')
	const beaOpened = await openCredentialClient(t.appContext(bea), {
		key: 'database',
	})
	await t.fetchAs(bea, beaOpened.handle)

	const rows = await t.auditRows()
	expect(rows.map((row) => row.result)).toEqual([
		'success',
		'success',
		'success',
	])
	const [anonymousRow, annRow, beaRow] = rows
	expect(anonymousRow).toMatchObject({
		actorUserId: t.people.bea.stableUserId,
		details: {
			appPackageId: t.packageId,
			ownerCredentialForVisitors: 'true',
			credentialAuthorityUserId: t.people.bea.stableUserId,
			viewerUserId: null,
			viewerKind: 'anonymous',
		},
	})
	expect(annRow).toMatchObject({
		actorUserId: t.people.bea.stableUserId,
		details: {
			ownerCredentialForVisitors: 'true',
			credentialAuthorityUserId: t.people.bea.stableUserId,
			viewerUserId: t.people.ann.stableUserId,
			viewerKind: 'person',
		},
	})
	expect(beaRow?.actorUserId).toBe(t.people.bea.stableUserId)
	expect(beaRow?.details).not.toHaveProperty('ownerCredentialForVisitors')
	expect(beaRow?.details).not.toHaveProperty('viewerKind')
	expect(JSON.stringify(rows)).not.toContain(resendKey)
})

test('a private app or an unapproved commit ignores the opt-in, and visitors use only what the owner approved', async () => {
	const privateApp = await setupVisitorApp({ internetVisible: false })
	await expect(
		rejection(
			openCredentialClient(privateApp.appContext(null), { key: 'database' }),
		),
	).resolves.toMatchObject({
		body: { code: 'credential_denied' },
		message: expect.stringContaining('no acting person'),
	})
	// Ann opens as herself, and she has no Use on rooms-db.
	await expect(
		rejection(
			openCredentialClient(
				privateApp.appContext(privateApp.requestAs('ann', 'member')),
				{ key: 'database' },
			),
		),
	).resolves.toMatchObject({ body: { code: 'credential_unbound' } })

	const unapproved = await setupVisitorApp({ approvedCommit: 'commit-0' })
	await expect(
		rejection(
			openCredentialClient(unapproved.appContext(null), { key: 'database' }),
		),
	).resolves.toMatchObject({ body: { code: 'credential_denied' } })

	const unlisted = await setupVisitorApp({
		approvedCredentialIds: () => ['some-other-credential'],
	})
	await expect(
		rejection(
			openCredentialClient(unlisted.appContext(null), { key: 'database' }),
		),
	).resolves.toMatchObject({
		body: { code: 'credential_denied' },
		message: expect.stringContaining(
			'has not approved for this app’s visitors',
		),
	})

	const goneApprover = await setupVisitorApp({
		approvedBy: testStableUserIdFromEmail('gone@example.com'),
	})
	await expect(
		rejection(
			openCredentialClient(goneApprover.appContext(null), { key: 'database' }),
		),
	).resolves.toMatchObject({
		body: { code: 'credential_denied' },
		message: expect.stringContaining('can no longer use its org’s credentials'),
	})
})

test('a suspended approver stops visitor credential use even when authority was cached', async () => {
	const t = await setupVisitorApp()
	const opened = await openCredentialClient(t.appContext(null), {
		key: 'database',
	})
	await t.fetchAs(null, opened.handle)
	await t.db
		.prepare(`UPDATE users SET suspended_at = ? WHERE stable_user_id = ?`)
		.bind(new Date().toISOString(), t.people.bea.stableUserId)
		.run()
	await expect(
		rejection(t.fetchAs(null, opened.handle)),
	).resolves.toMatchObject({
		body: { code: 'invalid_request' },
	})
	await expect(
		rejection(openCredentialClient(t.appContext(null), { key: 'database' })),
	).resolves.toMatchObject({
		body: { code: 'credential_denied' },
		message: expect.stringContaining('can no longer use its org’s credentials'),
	})
})

test('a visitor handle fails once the approval no longer lists that credential', async () => {
	const t = await setupVisitorApp()
	const opened = await openCredentialClient(t.appContext(null), {
		key: 'database',
	})
	await t.fetchAs(null, opened.handle)
	await t.db
		.prepare(
			`UPDATE package_capability_approvals
			 SET capability_set_json = ?
			 WHERE package_id = ? AND owner_user_id = ?`,
		)
		.bind(
			JSON.stringify([
				{
					kind: 'credential',
					credentialId: 'some-other-credential',
					source: 'need',
					needKey: 'database',
					ownerCredentialForVisitors: true,
					hosts: ['db.example.com'],
					via: ['rooms'],
				},
			]),
			t.packageId,
			t.acmeId,
		)
		.run()
	await expect(t.fetchAs(null, opened.handle)).rejects.toMatchObject({
		body: { code: 'invalid_request' },
	})
})

test('visitor use of an owner credential is rate-limited across viewers; the owner is not', async () => {
	const t = await setupVisitorApp()
	const original = ownerCredentialForVisitorsRateLimitConfig.maxRequests
	ownerCredentialForVisitorsRateLimitConfig.maxRequests = 1
	try {
		const opened = await openCredentialClient(t.appContext(null), {
			key: 'database',
		})
		await t.fetchAs(null, opened.handle)
		await expect(
			rejection(t.fetchAs(null, opened.handle)),
		).resolves.toMatchObject({
			body: { code: 'credential_rate_limited' },
			message: expect.stringMatching(/^\[credential_rate_limited\] /),
		})
		// Ann shares the same visitor budget as anonymous.
		const ann = t.requestAs('ann', 'member')
		const annOpened = await openCredentialClient(t.appContext(ann), {
			key: 'database',
		})
		await expect(
			rejection(t.fetchAs(ann, annOpened.handle)),
		).resolves.toMatchObject({ body: { code: 'credential_rate_limited' } })
		const bea = t.requestAs('bea', 'owner')
		const beaOpened = await openCredentialClient(t.appContext(bea), {
			key: 'database',
		})
		await t.fetchAs(bea, beaOpened.handle)
		await t.fetchAs(bea, beaOpened.handle)
	} finally {
		ownerCredentialForVisitorsRateLimitConfig.maxRequests = original
	}
})
