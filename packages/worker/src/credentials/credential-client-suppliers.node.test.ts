import { type McpCallerContext } from '@kody-internal/shared/chat.ts'
import { personalOrgId } from '@kody-internal/shared/owner-person-ids.ts'
import type * as CloudflareWorkers from 'cloudflare:workers'
import { expect, test, vi } from 'vitest'
import { saveSecret } from '#mcp/secrets/service.ts'
import {
	mappingFixtureNow as now,
	setupPackageCredentialMappingFixture,
} from '#worker/test-support/package-credential-mapping-fixture.ts'
import { insertSavedPackage } from '#worker/package-registry/repo.ts'
import { deriveRequestContext } from '#worker/request-context/request-context.ts'
import {
	buildWriteCredentialMappingStatement,
	runCredentialMappingWrite,
	type CredentialMappingRowTarget,
} from './credential-mappings.ts'
import * as needsClosure from './credential-needs-closure.ts'
import {
	ownCredentialNeeds,
	savedCredentialNeeds,
	type CredentialNeed,
	type SavedCredentialNeed,
} from './credential-needs.ts'
import { normalizeCredentialCallMap } from './credential-call-map.ts'
import {
	applyCredentialClient,
	openCredentialClient,
	validateCredentialCallMap,
	type CredentialClientContext,
} from './credential-client.ts'

const mocks = vi.hoisted(() => ({ loadPackageManifestBySourceId: vi.fn() }))

vi.mock('cloudflare:workers', async (importOriginal) => ({
	...(await importOriginal<typeof CloudflareWorkers>()),
	waitUntil: (promise: Promise<unknown>) => {
		void promise.catch(() => {})
	},
}))
vi.mock(
	'#worker/test-support/apply-all-migrations.ts',
	async (importOriginal) =>
		(await import('./cached-migrations.test-support.ts')).withCachedMigrations(
			await importOriginal(),
		),
)
vi.mock('#worker/package-registry/source.ts', async () => {
	const { createSubscriptionDiscoverySourceMocks } =
		await import('#worker/test-support/package-subscription-source-mocks.ts')
	return createSubscriptionDiscoverySourceMocks(
		mocks.loadPackageManifestBySourceId,
	)
})

const setup = () =>
	setupPackageCredentialMappingFixture({
		loadPackageManifestBySourceId: mocks.loadPackageManifestBySourceId,
	})

type Fixture = Awaited<ReturnType<typeof setup>>

const contextFor = (
	t: Fixture,
	request: ReturnType<Fixture['requestAs']>,
	packageId: string,
): CredentialClientContext => ({
	env: t.env,
	callerContext: {
		baseUrl: 'https://example.com',
		request,
		user: null,
	} as unknown as McpCallerContext,
	binding: 'run:test',
	packageId,
	callMap: normalizeCredentialCallMap(undefined),
})

const rejection = async (promise: Promise<unknown>) =>
	await promise.then(
		() => {
			throw new Error('Expected a rejection.')
		},
		(error: unknown) => error as Error & { body?: unknown },
	)

const mockNeeds = (needs: Array<Partial<CredentialNeed> & { key: string }>) =>
	vi.spyOn(needsClosure, 'loadPublishedCredentialNeeds').mockResolvedValue(
		needs.map((need) => ({
			kind: 'secret',
			provider: need.key,
			description: '',
			multiple: false,
			...need,
		})),
	)

const mapCredential = async (
	t: Fixture,
	input: {
		packageId: string
		needKey: string
		target: CredentialMappingRowTarget
		credentialId: string
	},
) =>
	await runCredentialMappingWrite(
		t.db,
		buildWriteCredentialMappingStatement({
			db: t.db,
			orgId: t.acmeId,
			packageId: input.packageId,
			needKey: input.needKey,
			target: input.target,
			credentialIds: [input.credentialId],
			updatedByUserId: t.people.bea.personId,
			now,
		}),
	)

const savePackage = async (
	t: Fixture,
	ownerId: Fixture['acmeId'],
	name: string,
) => {
	const id = crypto.randomUUID()
	await insertSavedPackage(
		t.db,
		{
			id,
			user_id: ownerId,
			name,
			kody_id: name.split('/')[1]!,
			description: 'test package',
			tags_json: '[]',
			search_text: null,
			source_id: `source-${id}`,
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
	return id
}

test('flag-off runtime resolution still uses a legacy org mapping', async () => {
	const t = await setup()
	const credentialId = await t.storeKey('legacy-mail', 'resend')
	const packageId = t.savedPackage.id
	const needs = ownCredentialNeeds(
		{
			mail: {
				provider: 'resend',
				description: 'Mail access.',
				supplier: 'publisher',
			},
		},
		{ supplierSemanticsEnabled: false },
	)
	expect(needs[0]).not.toHaveProperty('supplier')
	mockNeeds(needs)
	await mapCredential(t, {
		packageId,
		needKey: 'mail',
		target: { target: 'org' },
		credentialId,
	})
	await expect(
		openCredentialClient(
			contextFor(t, t.requestAs('bea', 'owner'), packageId),
			{ key: 'mail' },
		),
	).resolves.toMatchObject({ name: 'legacy-mail' })
})

test('publisher needs retain existing personal and trigger mappings', async () => {
	const t = await setup()
	const personal = await t.storeKey('mail-personal', 'resend')
	const triggerCredential = await t.storeKey('mail-trigger', 'resend')
	await t.grantUse(personal, 'bea')
	await t.grantUse(triggerCredential, 'ann')
	const packageId = t.savedPackage.id
	mockNeeds([{ key: 'mail', provider: 'resend', supplier: 'publisher' }])
	await mapCredential(t, {
		packageId,
		needKey: 'mail',
		target: { target: 'mine', personId: t.people.bea.personId },
		credentialId: personal,
	})
	await expect(
		openCredentialClient(
			contextFor(t, t.requestAs('bea', 'owner'), packageId),
			{ key: 'mail' },
		),
	).resolves.toMatchObject({ name: 'mail-personal' })

	const enablementId = 'enablement-ann-weekly'
	const triggerRequest = deriveRequestContext({
		user: { userId: t.people.ann.personId },
		source: {
			kind: 'schedule',
			jobId: 'job-mail',
			enablement: {
				id: enablementId,
				enabler: { userId: t.people.ann.personId },
				role: 'member',
			},
		},
		orgBinding: {
			org: { id: t.acmeId, slug: 'acme-clients' },
			role: null,
		},
	})
	await mapCredential(t, {
		packageId,
		needKey: 'mail',
		target: {
			target: 'enablement',
			enablementId,
			personId: t.people.ann.personId,
		},
		credentialId: triggerCredential,
	})
	await expect(
		openCredentialClient(contextFor(t, triggerRequest, packageId), {
			key: 'mail',
		}),
	).resolves.toMatchObject({ name: 'mail-trigger' })
})

test('call maps cannot select publisher-supplied credentials', async () => {
	const t = await setup()
	const packageId = t.savedPackage.id
	const request = t.requestAs('bea', 'owner')
	vi.spyOn(needsClosure, 'loadPublishedCredentialNeeds').mockResolvedValue([
		{
			key: 'mail',
			kind: 'secret',
			provider: 'resend',
			description: 'Publisher email.',
			multiple: false,
			supplier: 'publisher',
		},
	])
	const refusal = await rejection(
		validateCredentialCallMap({
			env: t.env,
			request,
			map: normalizeCredentialCallMap({ mail: 'mailer' })!,
			packageIds: [packageId],
			strict: true,
			baseUrl: 'https://example.com',
		}),
	)
	expect(refusal.body).toMatchObject({
		code: 'invalid_request',
		message:
			'Credential need "mail" is supplied by the publisher. Only the org-level mapping can set it.',
	})
	vi.spyOn(needsClosure, 'loadPublishedCredentialNeeds').mockResolvedValue(
		ownCredentialNeeds(
			{
				mail: {
					kind: 'secret',
					provider: 'resend',
					description: 'Publisher email.',
					ownerCredentialForVisitors: true,
				},
			},
			{ supplierSemanticsEnabled: true },
		),
	)
	await expect(
		rejection(
			validateCredentialCallMap({
				env: t.env,
				request,
				map: normalizeCredentialCallMap({ mail: 'mailer' })!,
				packageIds: [packageId],
				strict: true,
				baseUrl: 'https://example.com',
			}),
		),
	).resolves.toMatchObject({
		body: {
			code: 'invalid_request',
			message:
				'Credential need "mail" is supplied by the publisher. Only the org-level mapping can set it.',
		},
	})
})

test('ownerCredentialForVisitors has the same publisher visitor refusal as supplier publisher', async () => {
	const t = await setup()
	const request = t.requestAs('ann', 'member')
	const canonical: SavedCredentialNeed = {
		key: 'database',
		kind: 'secret',
		provider: 'database',
		description: 'Database access.',
		multiple: false,
		supplier: 'publisher',
	}
	const alias = savedCredentialNeeds(
		ownCredentialNeeds(
			{
				database: {
					description: 'Database access.',
					ownerCredentialForVisitors: true,
				},
			},
			{ supplierSemanticsEnabled: true },
		),
	)[0]!
	const authority: NonNullable<CredentialClientContext['packageAppAuthority']> =
		{
			issue: { visitorNeed: 'database' },
			runsAsRequest: async () => null,
			visitorNeedRequest: async () => request,
			visitorNeedGrant: async () => null,
		}
	const context = (need: SavedCredentialNeed): CredentialClientContext => ({
		...contextFor(t, request, t.savedPackage.id),
		runNeeds: async () => new Map([[need.key, need]]),
		packageAppAuthority: authority,
	})
	const canonicalError = await rejection(
		openCredentialClient(context(canonical), { key: 'database' }),
	)
	await expect(
		rejection(openCredentialClient(context(alias), { key: 'database' })),
	).resolves.toMatchObject({
		body: { code: 'credential_denied' },
		message: canonicalError.message,
	})
})

test('executor visitor credentials are isolated by grant and filtered against the visitor', async () => {
	const t = await setup()
	const publisherCredentialId = await t.storeKey('publisher-db', 'database')
	const personalOrgIdForAnn = personalOrgId(t.people.ann.personId)
	await saveSecret({
		env: t.env,
		userId: personalOrgIdForAnn,
		scope: 'user',
		name: 'visitor-db',
		value: 'fixture-value',
		audit: null,
	})
	const visitorCredential = await t.db
		.prepare(
			`UPDATE secret_entries SET kind = 'secret', provider = 'database',
			 allowed_hosts = '["api.example.com"]'
			 WHERE name = 'visitor-db' AND bucket_id IN (
			   SELECT id FROM secret_buckets WHERE user_id = ? AND scope = 'user'
			 ) RETURNING id`,
		)
		.bind(personalOrgIdForAnn)
		.first<{ id: string }>()
	expect(visitorCredential).toBeTruthy()
	const visitorCredentialIdResolved = visitorCredential!.id
	const appX = t.savedPackage.id
	const appY = await savePackage(t, t.acmeId, '@fixture/app-y')
	const otherOrgApp = await savePackage(
		t,
		personalOrgIdForAnn,
		'@fixture/other-org-app',
	)
	const need: SavedCredentialNeed = {
		key: 'database',
		kind: 'secret',
		provider: 'database',
		description: 'Database access.',
		multiple: false,
		supplier: 'executor',
		required: true,
	}
	mockNeeds([need])
	const visitorRequest = deriveRequestContext({
		user: { userId: t.people.ann.personId, username: 'ann' },
		source: { kind: 'session' },
		orgBinding: {
			org: { id: personalOrgIdForAnn, slug: 'ann' },
			role: 'owner',
		},
	})
	const triggerRequest = deriveRequestContext({
		user: { userId: t.people.ann.personId },
		source: {
			kind: 'schedule',
			jobId: 'job-app',
			enablement: {
				id: 'enablement-app',
				enabler: { userId: t.people.ann.personId },
				role: 'member',
			},
		},
		orgBinding: { org: { id: t.acmeId, slug: 'acme-clients' }, role: null },
	})
	for (const target of [
		{ target: 'org' },
		{ target: 'mine', personId: t.people.ann.personId },
		{
			target: 'enablement',
			enablementId: 'enablement-app',
			personId: t.people.ann.personId,
		},
	] satisfies Array<CredentialMappingRowTarget>) {
		await mapCredential(t, {
			packageId: appY,
			needKey: 'database',
			target,
			credentialId: publisherCredentialId,
		})
	}
	for (const grantId of ['grant-app-x', 'grant-app-y', 'grant-other-org']) {
		await t.db
			.prepare(
				`INSERT INTO package_app_oauth_grants
				 (id, person_id, org_username, kody_id, scopes, created_at)
				 VALUES (?, ?, 'fixture-org', ?, 'profile need:database', ?)`,
			)
			.bind(grantId, t.people.ann.personId, grantId, now)
			.run()
	}
	await t.db
		.prepare(
			`INSERT INTO package_app_grant_credential_mappings
			 (grant_id, need_key, credential_ids_json, created_at, updated_at)
			 VALUES (?, 'database', ?, ?, ?)`,
		)
		.bind(
			'grant-app-x',
			JSON.stringify([visitorCredentialIdResolved]),
			now,
			now,
		)
		.run()
	let grantActive = true
	const makeContext = (
		request: ReturnType<Fixture['requestAs']>,
		packageId: string,
		grantId: string,
	): CredentialClientContext => ({
		...contextFor(t, request, packageId),
		runNeeds: async () => new Map([[need.key, need]]),
		packageAppAuthority: {
			issue: { visitorNeed: need.key },
			runsAsRequest: async () => null,
			visitorNeedRequest: async () => (grantActive ? visitorRequest : null),
			visitorNeedGrant: async () =>
				grantActive ? { request: visitorRequest, grantId } : null,
		},
	})
	const appXContext = makeContext(triggerRequest, appX, 'grant-app-x')
	const opened = await openCredentialClient(appXContext, { key: need.key })
	expect(opened).toMatchObject({ name: 'visitor-db' })
	const applyOpened = () =>
		applyCredentialClient({
			env: t.env,
			request: triggerRequest,
			baseUrl: 'https://example.com',
			packageId: appX,
			binding: 'run:test',
			packageAppAuthority: appXContext.packageAppAuthority,
			token: opened.handle,
			requestUrl: new URL('https://api.example.com/v1'),
		})
	await expect(applyOpened()).resolves.toMatchObject({
		placement: { kind: 'header', value: 'Bearer fixture-value' },
	})
	await expect(
		openCredentialClient(makeContext(triggerRequest, appY, 'grant-app-y'), {
			key: need.key,
		}),
	).rejects.toMatchObject({ body: { code: 'credential_unbound' } })
	await expect(
		openCredentialClient(
			makeContext(visitorRequest, otherOrgApp, 'grant-other-org'),
			{ key: need.key },
		),
	).rejects.toMatchObject({ body: { code: 'credential_unbound' } })
	await t.db
		.prepare(
			`UPDATE package_app_grant_credential_mappings
			 SET credential_ids_json = ? WHERE grant_id = 'grant-app-x'`,
		)
		.bind(JSON.stringify([publisherCredentialId]))
		.run()
	await expect(
		openCredentialClient(appXContext, { key: need.key }),
	).rejects.toMatchObject({ body: { code: 'credential_unbound' } })
	await t.db
		.prepare(
			`UPDATE package_app_grant_credential_mappings
			 SET credential_ids_json = '[]' WHERE grant_id = 'grant-app-x'`,
		)
		.run()
	await expect(applyOpened()).rejects.toMatchObject({
		body: { code: 'credential_unbound' },
	})
	await t.db
		.prepare(
			`UPDATE package_app_grant_credential_mappings
			 SET credential_ids_json = ? WHERE grant_id = 'grant-app-x'`,
		)
		.bind(JSON.stringify([visitorCredentialIdResolved]))
		.run()
	grantActive = false
	await expect(applyOpened()).rejects.toMatchObject({
		body: { code: 'invalid_request' },
	})
	await expect(
		openCredentialClient(
			{
				...contextFor(t, t.requestAs('bea', 'owner'), appX),
				runNeeds: async () => new Map([[need.key, need]]),
			},
			{ key: need.key },
		),
	).resolves.toMatchObject({ name: 'publisher-db' })
})

test('flag-off legacy visitor handles still require live consent after grant revoke', async () => {
	const t = await setup()
	const credentialId = await t.storeKey('publisher-db', 'database')
	await mapCredential(t, {
		packageId: t.savedPackage.id,
		needKey: 'database',
		target: { target: 'org' },
		credentialId,
	})
	const need: SavedCredentialNeed = {
		key: 'database',
		kind: 'secret',
		provider: 'database',
		description: 'Database access.',
		multiple: false,
	}
	mockNeeds([need])
	let grantActive = true
	const request = t.requestAs('bea', 'owner')
	const packageAppAuthority: NonNullable<
		CredentialClientContext['packageAppAuthority']
	> = {
		issue: { visitorNeed: need.key },
		runsAsRequest: async () => null,
		visitorNeedRequest: async () => (grantActive ? request : null),
		visitorNeedGrant: async () =>
			grantActive ? { request, grantId: 'legacy-grant' } : null,
	}
	const context: CredentialClientContext = {
		...contextFor(t, request, t.savedPackage.id),
		runNeeds: async () => new Map([[need.key, need]]),
		packageAppAuthority,
	}
	const opened = await openCredentialClient(context, { key: need.key })
	const applyOpened = () =>
		applyCredentialClient({
			env: t.env,
			request,
			baseUrl: 'https://example.com',
			packageId: t.savedPackage.id,
			binding: 'run:test',
			packageAppAuthority,
			token: opened.handle,
			requestUrl: new URL('https://api.example.com/v1'),
		})
	await expect(applyOpened()).resolves.toMatchObject({
		placement: { kind: 'header' },
	})
	grantActive = false
	await expect(applyOpened()).rejects.toMatchObject({
		body: { code: 'invalid_request' },
	})
})
