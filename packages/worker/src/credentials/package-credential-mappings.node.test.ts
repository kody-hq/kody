import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { getJobRowById, insertJobRow } from '@kody-internal/shared/jobs/repo.ts'
import { expect, test, vi } from 'vitest'
import { createSubscriptionDiscoverySourceMocks } from '#worker/test-support/package-subscription-source-mocks.ts'
import { buildPackageJobId } from '#worker/jobs/package-job-id.ts'
import type * as ManagerClient from '#worker/jobs/manager-client.ts'
import { loadPackageMappingScopeForViewer } from '#app/package-credentials-access.ts'
import { loadPersonalOrgIdForPerson } from '#worker/orgs/personal-org-id.ts'
import { saveSecret } from '#mcp/secrets/service.ts'
import {
	dailyTarget as daily,
	mappingFixtureBaseUrl as baseUrl,
	mappingFixtureNow as now,
	mineTarget as mine,
	orgDefaultTarget as orgDefault,
	setupPackageCredentialMappingFixture,
} from '#worker/test-support/package-credential-mapping-fixture.ts'
import {
	resolveMappingChanges,
	writeMappingChanges,
} from './package-credential-mapping-changes.ts'
import { buildPackageCredentialsView } from './package-credential-mappings.ts'

vi.mock(
	'#worker/test-support/apply-all-migrations.ts',
	async (importOriginal) =>
		(await import('./cached-migrations.test-support.ts')).withCachedMigrations(
			await importOriginal(),
		),
)

const mocks = vi.hoisted(() => ({ loadPackageManifestBySourceId: vi.fn() }))

const alarm = vi.hoisted(() => ({ fail: false }))
vi.mock('#worker/jobs/manager-client.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof ManagerClient>()
	return {
		...actual,
		syncJobManagerAlarm: async (
			input: Parameters<typeof actual.syncJobManagerAlarm>[0],
		) => {
			if (alarm.fail) throw new Error('alarm sync failed')
			return await actual.syncJobManagerAlarm(input)
		},
	}
})

vi.mock('#worker/package-registry/source.ts', () =>
	createSubscriptionDiscoverySourceMocks(mocks.loadPackageManifestBySourceId),
)

const setup = () =>
	setupPackageCredentialMappingFixture({
		loadPackageManifestBySourceId: mocks.loadPackageManifestBySourceId,
	})

test('flag-off mapping writes keep accepting legacy needs', async () => {
	const t = await setup()
	const prod = await t.storeKey('resend-prod', 'resend')
	const scope = await t.scopeFor('bea', 'owner')
	expect(
		scope.needs.find((need) => need.key === 'mail')?.supplier,
	).toBeUndefined()
	const changes = await t.apply('bea', 'owner', [
		{ target: orgDefault, needKey: 'mail', credentials: [{ id: prod }] },
	])

	await expect(writeMappingChanges(scope, changes)).resolves.toBeUndefined()
	const view = await buildPackageCredentialsView(
		await t.scopeFor('bea', 'owner'),
	)
	expect(
		view.needs.find((need) => need.key === 'mail')?.defaults.org,
	).toMatchObject({
		credentials: [{ id: prod }],
	})
})

test('the view shows needs, options, triggers, and what is incomplete', async () => {
	const t = await setup()
	await t.storeKey('resend-prod', 'resend')
	await t.storeKey('resend-test', 'resend')
	const view = await buildPackageCredentialsView(
		await t.scopeFor('bea', 'owner'),
	)
	expect(view.package).toEqual({
		id: t.savedPackage.id,
		kodyId: 'digest',
		canManage: true,
	})
	const [mail, chat] = view.needs
	expect(mail).toMatchObject({
		key: 'mail',
		kind: 'secret',
		provider: 'resend',
		defaults: { org: null, mine: null },
		effective: { source: 'auto', status: 'ambiguous', credentials: [] },
	})
	expect(mail!.effective.candidates.map((ref) => ref.name)).toEqual([
		'resend-prod',
		'resend-test',
	])
	expect(mail!.options.map((ref) => ref.name)).toEqual([
		'resend-prod',
		'resend-test',
	])
	expect(new URL(mail!.createUrl).searchParams.get('forPackage')).toBe('digest')
	expect(chat!.effective).toMatchObject({ status: 'unbound', source: 'auto' })
	expect(chat!.effective.createUrl).toBe(chat!.createUrl)
	expect(
		view.triggers.map((trigger) => [
			trigger.trigger.kind,
			trigger.trigger.name,
			trigger.enablement,
			trigger.canEdit,
		]),
	).toEqual([
		['cron', 'daily', null, true],
		['subscription', 'acme.thing.happened', null, true],
		['webhook', 'incoming', null, false],
	])
	expect(view.triggers[2]!.instanceId).toBeNull()
	expect(view.triggers.map((trigger) => trigger.instances)).toEqual([
		[],
		[],
		[],
	])
	expect(view.triggers.map((trigger) => trigger.canAddInstance)).toEqual([
		true,
		true,
		false,
	])
	expect(view.incomplete).toEqual([
		{ needKey: 'mail', where: { type: 'default' }, status: 'ambiguous' },
		{ needKey: 'chat', where: { type: 'default' }, status: 'unbound' },
	])
})

test('publisher needs offer and auto-resolve only org credentials', async () => {
	const t = await setup()
	await t.storeKey('org-mail', 'resend')
	const beaPersonalOrgId = await loadPersonalOrgIdForPerson(
		t.db,
		t.people.bea.personId,
	)
	await saveSecret({
		env: t.env,
		userId: beaPersonalOrgId,
		scope: 'user',
		name: 'personal-mail',
		value: 'v',
		audit: null,
	})
	await t.db
		.prepare(
			`UPDATE secret_entries SET provider = 'resend'
			 WHERE name = 'personal-mail' AND bucket_id IN (
			   SELECT id FROM secret_buckets WHERE user_id = ? AND scope = 'user'
			 )`,
		)
		.bind(beaPersonalOrgId)
		.run()
	const scope = await t.scopeFor('bea', 'owner')
	scope.needs = scope.needs.map((need) =>
		need.key === 'mail' ? { ...need, supplier: 'publisher' } : need,
	)
	const view = await buildPackageCredentialsView(scope)
	const mail = view.needs.find((need) => need.key === 'mail')
	expect(mail?.options.map((credential) => credential.name)).toEqual([
		'org-mail',
	])
	expect(mail?.effective).toMatchObject({
		source: 'auto',
		status: 'ready',
		credentials: [{ name: 'org-mail', scope: 'org' }],
	})
})

test('publisher needs allow clearing grandfathered personal and trigger mappings but refuse sets', async () => {
	const t = await setup()
	const credentialId = await t.storeKey('resend-prod', 'resend')
	await t.apply('bea', 'owner', [
		{ target: mine, needKey: 'mail', credentials: [{ id: credentialId }] },
		{ target: daily, needKey: 'mail', credentials: [{ id: credentialId }] },
	])
	const scope = await t.scopeFor('bea', 'owner')
	scope.needs = scope.needs.map((need) =>
		need.key === 'mail' ? { ...need, supplier: 'publisher' } : need,
	)

	const setChanges = await resolveMappingChanges(scope, [
		{ target: mine, needKey: 'mail', credentials: [{ id: credentialId }] },
		{ target: daily, needKey: 'mail', credentials: [{ id: credentialId }] },
	])
	expect(setChanges.map((change) => change.error?.code ?? null)).toEqual([
		'not_allowed',
		'not_allowed',
	])

	const clearChanges = await resolveMappingChanges(scope, [
		{ target: mine, needKey: 'mail', credentials: null },
		{ target: daily, needKey: 'mail', credentials: null },
	])
	expect(clearChanges.map((change) => change.error)).toEqual([null, null])
	await expect(
		writeMappingChanges(
			scope,
			clearChanges.map((change) => ({
				...change,
				credentialIds: [credentialId],
			})),
		),
	).rejects.toThrow(/Only the org-level mapping can set it/)

	await expect(
		writeMappingChanges(scope, clearChanges, { now }),
	).resolves.toBeUndefined()
	const view = await buildPackageCredentialsView(
		await t.scopeFor('bea', 'owner'),
	)
	expect(
		view.needs.find((need) => need.key === 'mail')?.defaults.mine,
	).toBeNull()
	expect(
		view.triggers
			.find((trigger) => trigger.trigger.name === 'daily')
			?.instances[0]?.mappings.find((mapping) => mapping.needKey === 'mail')
			?.override,
	).toBeNull()
})

test('one write sets defaults and a trigger mapping, turning the trigger on', async () => {
	const t = await setup()
	const prod = await t.storeKey('resend-prod', 'resend')
	const test_ = await t.storeKey('resend-test', 'resend')
	const resolved = await t.apply('bea', 'owner', [
		{
			target: orgDefault,
			needKey: 'mail',
			credentials: [{ name: 'resend-prod', scope: 'org' }],
		},
		{ target: mine, needKey: 'chat', credentials: [] },
		{ target: daily, needKey: 'mail', credentials: [{ id: test_ }] },
	])
	expect(resolved.map((change) => [change.error, change.willEnable])).toEqual([
		[null, false],
		[null, false],
		[null, true],
	])
	expect(await t.enablementCount()).toBe(1)

	const view = await buildPackageCredentialsView(
		await t.scopeFor('bea', 'owner'),
	)
	const [mail, chat] = view.needs
	expect(mail!.defaults.org).toMatchObject({
		credentials: [
			{ id: prod, name: 'resend-prod', scope: 'org', kind: 'secret' },
		],
		unusableIds: [],
		updatedAt: now,
	})
	expect(mail!.effective).toMatchObject({ source: 'org', status: 'ready' })
	expect(chat!.defaults.mine?.credentials).toEqual([])
	expect(chat!.effective).toMatchObject({ source: 'mine', status: 'none' })
	const trigger = view.triggers[0]!
	expect(trigger.enablement).toMatchObject({ state: 'on', enabledByYou: true })
	expect(trigger.mappings[0]).toMatchObject({
		needKey: 'mail',
		override: { credentials: [{ id: test_ }] },
		effective: {
			source: 'trigger',
			status: 'ready',
			credentials: [{ id: test_ }],
		},
	})
	expect(trigger.mappings[1]!.effective).toMatchObject({
		source: 'mine',
		status: 'none',
	})
	expect(view.incomplete).toEqual([])

	const afterWrite = await t.mappingAudits()
	expect(afterWrite).toHaveLength(3)
	expect(afterWrite.map((row) => row.details)).toEqual([
		{
			packageId: t.savedPackage.id,
			kodyId: 'digest',
			needKey: 'mail',
			target: orgDefault,
			trigger: null,
			beforeCredentialIds: null,
			afterCredentialIds: [prod],
			willEnable: false,
		},
		{
			packageId: t.savedPackage.id,
			kodyId: 'digest',
			needKey: 'chat',
			target: mine,
			trigger: null,
			beforeCredentialIds: null,
			afterCredentialIds: [],
			willEnable: false,
		},
		{
			packageId: t.savedPackage.id,
			kodyId: 'digest',
			needKey: 'mail',
			target: daily,
			trigger: daily.trigger,
			beforeCredentialIds: null,
			afterCredentialIds: [test_],
			willEnable: true,
		},
	])
	for (const row of afterWrite) {
		expect(row).toMatchObject({
			actorUserId: t.people.bea.personId,
			actorUsername: 'bea',
			credentialKind: 'session',
			resourceType: 'package',
			resourceId: t.savedPackage.id,
		})
		expect(row.details).not.toHaveProperty('value')
		expect(row.details).not.toHaveProperty('credentials')
	}

	// A second write reuses the enablement and clearing restores inheritance.
	await t.apply('bea', 'owner', [
		{ target: daily, needKey: 'mail', credentials: null },
	])
	expect(await t.enablementCount()).toBe(1)
	const cleared = await buildPackageCredentialsView(
		await t.scopeFor('bea', 'owner'),
	)
	expect(cleared.triggers[0]!.mappings[0]).toMatchObject({
		override: null,
		effective: { source: 'org', status: 'ready', credentials: [{ id: prod }] },
	})
	const afterClear = await t.mappingAudits()
	expect(afterClear).toHaveLength(4)
	expect(afterClear[3]!.details).toEqual({
		packageId: t.savedPackage.id,
		kodyId: 'digest',
		needKey: 'mail',
		target: daily,
		trigger: daily.trigger,
		beforeCredentialIds: [test_],
		afterCredentialIds: null,
		willEnable: false,
	})
})

test('a set then clear of one trigger mapping never turns the trigger on', async () => {
	const t = await setup()
	await t.storeKey('resend-prod', 'resend')
	const resolved = await t.apply('bea', 'owner', [
		{ target: daily, needKey: 'mail', credentials: [{ name: 'resend-prod' }] },
		{ target: daily, needKey: 'mail', credentials: null },
	])
	expect(resolved.map((change) => change.error)).toEqual([null, null])
	expect(await t.enablementCount()).toBe(0)
	expect(await t.mappingAudits()).toEqual([])
})

test('the audit keeps stored ids the editor can no longer use', async () => {
	const t = await setup()
	const prod = await t.storeKey('resend-prod', 'resend')
	await t.apply('bea', 'owner', [
		{ target: orgDefault, needKey: 'mail', credentials: [{ id: prod }] },
	])
	await t.db
		.prepare(`UPDATE secret_entries SET deleted_at = ? WHERE id = ?`)
		.bind(now, prod)
		.run()
	await t.apply('bea', 'owner', [
		{ target: orgDefault, needKey: 'mail', credentials: null },
	])
	const audits = await t.mappingAudits()
	expect(audits[1]!.details).toMatchObject({
		beforeCredentialIds: [prod],
		afterCredentialIds: null,
	})
})

test('refused mapping changes write no credential.mapping.update audit', async () => {
	const t = await setup()
	await t.storeKey('resend-prod', 'resend')
	await t.apply('ann', 'member', [
		{
			target: orgDefault,
			needKey: 'mail',
			credentials: [{ name: 'resend-prod' }],
		},
	])
	expect(await t.mappingAudits()).toEqual([])
})

test('changes that cannot apply carry a coded error and nothing is written', async () => {
	const t = await setup()
	const prod = await t.storeKey('resend-prod', 'resend')
	await t.storeKey('slack-bot', 'slack')
	await t.grantUse(prod, 'ann')
	const resolved = await t.apply('ann', 'member', [
		{
			target: orgDefault,
			needKey: 'mail',
			credentials: [{ name: 'resend-prod' }],
		},
		{ target: mine, needKey: 'nope', credentials: [] },
		{ target: mine, needKey: 'chat', credentials: [{ name: 'slack-bot' }] },
		{ target: mine, needKey: 'mail', credentials: [{ name: 'org:missing' }] },
		{
			target: mine,
			needKey: 'mail',
			credentials: [{ name: 'resend-prod' }, { name: 'resend-prod' }],
		},
		{
			target: {
				type: 'trigger',
				trigger: { kind: 'webhook', name: 'incoming' },
			},
			needKey: 'mail',
			credentials: [{ name: 'resend-prod' }],
		},
		{
			target: { type: 'trigger', trigger: { kind: 'cron', name: 'weekly' } },
			needKey: 'mail',
			credentials: [{ name: 'resend-prod' }],
		},
		{ target: daily, needKey: 'mail', credentials: [{ name: 'resend-prod' }] },
	])
	expect(resolved.map((change) => change.error?.code ?? null)).toEqual([
		'not_allowed',
		'need_unknown',
		'credential_not_found',
		'credential_not_found',
		'too_many',
		'webhook_not_minted',
		'trigger_unknown',
		null,
	])
	expect(resolved[3]!.error?.createUrl).toContain(
		'/@acme-clients/-/credentials/new?',
	)
	expect(resolved[7]).toMatchObject({
		willEnable: true,
		after: [{ id: prod }],
	})
	expect(await t.enablementCount()).toBe(0)
	await expect(
		writeMappingChanges(await t.scopeFor('ann', 'member'), resolved),
	).rejects.toThrow(/errors/)

	const mismatch = await t.apply('bea', 'owner', [
		{ target: mine, needKey: 'mail', credentials: [{ name: 'slack-bot' }] },
	])
	expect(mismatch[0]!.error).toMatchObject({ code: 'provider_mismatch' })
})

test('createInstance adds a second enablement with its own credential mapping', async () => {
	const t = await setup()
	const prod = await t.storeKey('resend-prod', 'resend')
	const test_ = await t.storeKey('resend-test', 'resend')
	await t.apply('bea', 'owner', [
		{ target: daily, needKey: 'mail', credentials: [{ id: prod }] },
	])
	expect(await t.enablementCount()).toBe(1)
	const first = await buildPackageCredentialsView(
		await t.scopeFor('bea', 'owner'),
	)
	expect(first.triggers[0]!.instances).toHaveLength(1)
	expect(first.triggers[0]!.instances[0]!.mappings[0]).toMatchObject({
		needKey: 'mail',
		override: { credentials: [{ id: prod }] },
	})

	await t.apply('bea', 'owner', [
		{
			target: { ...daily, createInstance: true },
			needKey: 'mail',
			credentials: [{ id: test_ }],
		},
	])
	expect(await t.enablementCount()).toBe(2)
	const view = await buildPackageCredentialsView(
		await t.scopeFor('bea', 'owner'),
	)
	const cron = view.triggers[0]!
	expect(cron.instances).toHaveLength(2)
	expect(cron.canAddInstance).toBe(true)
	const mapped = cron.instances.map(
		(instance) => instance.mappings[0]?.override?.credentials[0]?.id ?? null,
	)
	expect(mapped.sort()).toEqual([prod, test_].sort())
})

test('an expired package-bound Key reads as expired, not missing, and skips attention', async () => {
	const t = await setup()
	await saveSecret({
		env: t.env,
		userId: t.acmeId,
		scope: 'package',
		name: 'mail',
		value: 'short-lived',
		expiresAt: '2020-01-01T00:00:00.000Z',
		storageContext: {
			sessionId: null,
			appId: t.savedPackage.id,
			packageId: t.savedPackage.id,
			storageId: t.savedPackage.id,
		},
		audit: null,
	})
	await t.db
		.prepare(
			`UPDATE secret_entries SET provider = 'resend', allowed_hosts = '["api.resend.com"]'
			WHERE name = 'mail' AND bucket_id IN (
				SELECT id FROM secret_buckets
				WHERE user_id = ? AND scope = 'package' AND binding_key = ?
			)`,
		)
		.bind(t.acmeId, t.savedPackage.id)
		.run()
	const view = await buildPackageCredentialsView(
		await t.scopeFor('bea', 'owner'),
	)
	const mail = view.needs.find((need) => need.key === 'mail')
	expect(mail?.effective).toMatchObject({
		source: 'auto',
		status: 'expired',
		credentials: [{ name: 'mail', kind: 'secret', scope: 'org' }],
		createUrl: null,
	})
	expect(view.incomplete).toEqual([
		{ needKey: 'chat', where: { type: 'default' }, status: 'unbound' },
	])
	expect(view.incomplete.some((item) => item.needKey === 'mail')).toBe(false)
})

test('the viewer scope binds the :username org and needs package:execute', async () => {
	const t = await setup()
	const viewer = (person: keyof typeof t.people) => ({
		mcpUser: {
			userId: t.people[person].personId,
			email: `${person}@example.com`,
			displayName: person,
		},
	})
	const load = (
		person: keyof typeof t.people,
		username: string,
		kodyId: string,
	) =>
		loadPackageMappingScopeForViewer({
			env: t.env,
			request: new Request(
				`${baseUrl}/profiles/${username}/packages/${kodyId}/credentials.json`,
			),
			user: viewer(person) as never,
			username,
			kodyId,
		})
	const owner = await load('bea', 'acme-clients', 'digest')
	expect(owner).toMatchObject({
		canManage: true,
		actorId: t.people.bea.personId,
	})
	expect(owner!.request.org.id).toBe(t.acmeId as OwnerId)
	// A private package needs a grant before a member can run it.
	expect(await load('ann', 'acme-clients', 'digest')).toBeNull()
	await t.grantPackageUse('ann')
	const member = await load('ann', 'acme-clients', 'digest')
	expect(member?.canManage).toBe(false)
	expect(await load('cy', 'acme-clients', 'digest')).toBeNull()
	expect(await load('bea', 'acme-clients', 'missing')).toBeNull()
	expect(await load('bea', 'ann', 'digest')).toBeNull()
})

test('approving a mapping that turns a cron trigger on turns its disabled job on too', async () => {
	const t = await setup()
	const jobId = buildPackageJobId(t.savedPackage.id, 'daily')
	const stale = '2026-01-01T00:00:00.000Z'
	await insertJobRow({
		db: t.db,
		userId: t.acmeId,
		job: {
			version: 1,
			id: jobId,
			userId: t.acmeId,
			name: 'daily',
			sourceId: t.savedPackage.sourceId,
			publishedCommit: 'commit-1',
			storageId: `job-storage-${jobId}`,
			schedule: { type: 'interval', every: '1d' },
			timezone: 'UTC',
			enabled: false,
			killSwitchEnabled: false,
			expiresAt: null,
			createdAt: now,
			updatedAt: now,
			nextRunAt: stale,
			runCount: 0,
			successCount: 0,
			errorCount: 0,
		},
		callerContextJson: '{}',
	})
	const prod = await t.storeKey('resend-prod', 'resend')
	const resolved = await t.apply('bea', 'owner', [
		{ target: daily, needKey: 'mail', credentials: [{ id: prod }] },
	])
	expect(resolved.map((change) => change.willEnable)).toEqual([true])
	const job = (await getJobRowById(t.db, t.acmeId, jobId))!.record
	expect(job.enabled).toBe(true)
	expect(job.nextRunAt).not.toBe(stale)
})

test('an alarm sync failure after the approval commits is logged, not thrown', async () => {
	const t = await setup()
	const jobId = buildPackageJobId(t.savedPackage.id, 'daily')
	const stale = '2026-01-01T00:00:00.000Z'
	await insertJobRow({
		db: t.db,
		userId: t.acmeId,
		job: {
			version: 1,
			id: jobId,
			userId: t.acmeId,
			name: 'daily',
			sourceId: t.savedPackage.sourceId,
			publishedCommit: 'commit-1',
			storageId: `job-storage-${jobId}`,
			schedule: { type: 'interval', every: '1d' },
			timezone: 'UTC',
			enabled: false,
			killSwitchEnabled: false,
			expiresAt: null,
			createdAt: now,
			updatedAt: now,
			nextRunAt: stale,
			runCount: 0,
			successCount: 0,
			errorCount: 0,
		},
		callerContextJson: '{}',
	})
	const prod = await t.storeKey('resend-prod', 'resend')
	const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
	alarm.fail = true
	try {
		// A thrown error would invite a retry that inserts a second instance.
		const resolved = await t.apply('bea', 'owner', [
			{ target: daily, needKey: 'mail', credentials: [{ id: prod }] },
		])
		expect(resolved.map((change) => change.willEnable)).toEqual([true])
		expect(await t.enablementCount()).toBe(1)
		expect(errorSpy).toHaveBeenCalledWith(
			'credential mapping: arming cron jobs failed',
			expect.objectContaining({ enablementIds: [expect.any(String)] }),
		)
	} finally {
		alarm.fail = false
		errorSpy.mockRestore()
	}
})
