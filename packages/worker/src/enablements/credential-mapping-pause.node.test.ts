import { expect, test, vi } from 'vitest'
import { createSubscriptionDiscoverySourceMocks } from '#worker/test-support/package-subscription-source-mocks.ts'
import * as needsClosure from '#worker/credentials/credential-needs-closure.ts'
import { buildPackageJobId } from '#worker/jobs/package-job-id.ts'
import {
	dailyTarget as daily,
	mappingFixtureNeeds,
	setupPackageCredentialMappingFixture,
} from '#worker/test-support/package-credential-mapping-fixture.ts'
import { planEnablementRuns } from './run-gate.ts'

const mocks = vi.hoisted(() => ({ loadPackageManifestBySourceId: vi.fn() }))

vi.mock('#worker/package-registry/source.ts', () =>
	createSubscriptionDiscoverySourceMocks(mocks.loadPackageManifestBySourceId),
)

async function setup() {
	const t = await setupPackageCredentialMappingFixture({
		loadPackageManifestBySourceId: mocks.loadPackageManifestBySourceId,
	})
	// The run gate only runs live enablers.
	for (const [username, person] of Object.entries(t.people)) {
		await t.db
			.prepare(
				`INSERT INTO users (username, email, password_hash, stable_user_id)
				VALUES (?, ?, 'hash', ?)`,
			)
			.bind(username, `${username}@example.com`, person.stableUserId)
			.run()
	}
	const owner = await t.db
		.prepare(
			`SELECT u.id
			 FROM org_memberships m
			 INNER JOIN users u ON u.stable_user_id = m.user_id
			 WHERE m.org_id = ? AND m.role = 'owner'`,
		)
		.bind(t.acmeId)
		.first<{ id: number }>()
	await t.db
		.prepare(
			`INSERT INTO feature_flag_user_overrides (flag_key, user_id, enabled)
			 VALUES ('package-credential-suppliers', ?, 1)
			 ON CONFLICT(flag_key, user_id) DO UPDATE SET enabled = 1`,
		)
		.bind(owner!.id)
		.run()
	const plan = () =>
		planEnablementRuns({
			env: t.env,
			orgId: t.acmeId,
			packageId: t.savedPackage.id,
			trigger: {
				kind: 'cron',
				instanceId: buildPackageJobId(t.savedPackage.id, 'daily'),
			},
		})
	const readEnablement = () =>
		t.db
			.prepare(
				`SELECT state, paused_reason, paused_resource_type, paused_resource_id,
					paused_credential_id
				FROM enablements WHERE package_id = ?`,
			)
			.bind(t.savedPackage.id)
			.first<Record<string, string | null>>()
	const setDeleted = (credentialId: string, deleted: boolean) =>
		t.db
			.prepare(`UPDATE secret_entries SET deleted_at = ? WHERE id = ?`)
			.bind(deleted ? '2026-10-13T01:00:00.000Z' : null, credentialId)
			.run()
	return { ...t, plan, readEnablement, setDeleted }
}

test('the supplier flag off leaves unmapped trigger runs on the legacy path', async () => {
	const t = await setup()
	await t.apply('bea', 'owner', [
		{ target: daily, needKey: 'chat', credentials: [] },
	])
	await t.db
		.prepare(
			`DELETE FROM feature_flag_user_overrides
			WHERE flag_key = 'package-credential-suppliers'`,
		)
		.run()
	const loadNeedsSpy = vi
		.spyOn(needsClosure, 'loadPublishedCredentialNeeds')
		.mockClear()

	expect((await t.plan()).runs).toHaveLength(1)
	expect(loadNeedsSpy).not.toHaveBeenCalled()
})

test('a trigger mapping naming a credential the enabler cannot use pauses before the run and resumes once it is usable', async () => {
	const t = await setup()
	const slack = await t.storeKey('team-slack', 'slack')
	await t.apply('bea', 'owner', [
		{ target: daily, needKey: 'chat', credentials: [{ name: 'team-slack' }] },
	])
	expect((await t.plan()).runs).toHaveLength(1)

	await t.setDeleted(slack, true)
	const paused = await t.plan()
	expect(paused.runs).toEqual([])
	expect(paused.skipped.map((skip) => skip.reason)).toEqual(['paused'])
	expect(await t.readEnablement()).toEqual({
		state: 'paused',
		paused_reason: 'credential_access',
		paused_resource_type: 'credential-mapping',
		paused_resource_id: 'chat',
		paused_credential_id: slack,
	})
	// Still missing: it stays paused, with the same cause.
	expect((await t.plan()).runs).toEqual([])
	expect((await t.readEnablement())?.paused_credential_id).toBe(slack)

	await t.setDeleted(slack, false)
	expect((await t.plan()).runs).toHaveLength(1)
	expect(await t.readEnablement()).toMatchObject({
		state: 'on',
		paused_reason: null,
	})
})

test('a required executor need without a trigger mapping pauses before the run', async () => {
	const t = await setup()
	await t.apply('bea', 'owner', [
		{ target: daily, needKey: 'chat', credentials: [] },
	])
	vi.spyOn(needsClosure, 'loadPublishedCredentialNeeds').mockResolvedValue([
		...mappingFixtureNeeds,
		{
			key: 'calendar',
			kind: 'oauth',
			provider: 'google',
			description: 'Read the calendar',
			supplier: 'executor',
			required: true,
			multiple: false,
		},
	])

	expect((await t.plan()).runs).toEqual([])
	expect(await t.readEnablement()).toMatchObject({
		state: 'paused',
		paused_reason: 'credential_access',
		paused_resource_type: 'credential-mapping',
		paused_resource_id: 'calendar',
		paused_credential_id: null,
	})
})

test('an optional executor need without a trigger mapping does not pause the run', async () => {
	const t = await setup()
	await t.apply('bea', 'owner', [
		{ target: daily, needKey: 'chat', credentials: [] },
	])
	vi.spyOn(needsClosure, 'loadPublishedCredentialNeeds').mockResolvedValue([
		...mappingFixtureNeeds,
		{
			key: 'calendar',
			kind: 'oauth',
			provider: 'google',
			description: 'Read the calendar',
			supplier: 'executor',
			required: false,
			multiple: false,
		},
	])

	expect((await t.plan()).runs).toHaveLength(1)
	expect(await t.readEnablement()).toMatchObject({
		state: 'on',
		paused_reason: null,
	})
})

test('remapping the need resumes a paused enablement on the next event', async () => {
	const t = await setup()
	const slack = await t.storeKey('team-slack', 'slack')
	await t.storeKey('backup-slack', 'slack')
	await t.apply('bea', 'owner', [
		{ target: daily, needKey: 'chat', credentials: [{ name: 'team-slack' }] },
	])
	await t.setDeleted(slack, true)
	expect((await t.plan()).runs).toEqual([])

	const remapped = await t.apply('bea', 'owner', [
		{ target: daily, needKey: 'chat', credentials: [{ name: 'backup-slack' }] },
	])
	expect(remapped.map((change) => change.error)).toEqual([null])
	expect((await t.plan()).runs).toHaveLength(1)
	expect((await t.readEnablement())?.state).toBe('on')
})

test('none on purpose and default-layer mappings never pause an enablement', async () => {
	const t = await setup()
	const prod = await t.storeKey('resend-prod', 'resend')
	await t.apply('bea', 'owner', [
		{ target: daily, needKey: 'chat', credentials: [] },
		{
			target: { type: 'default', layer: 'org' },
			needKey: 'mail',
			credentials: [{ name: 'resend-prod', scope: 'org' }],
		},
	])
	await t.setDeleted(prod, true)
	expect((await t.plan()).runs).toHaveLength(1)
	expect((await t.readEnablement())?.state).toBe('on')
})

test('a stored credential-access pause stays in place while a mapping breaks and after it is fixed', async () => {
	const t = await setup()
	const slack = await t.storeKey('team-slack', 'slack')
	await t.grantPackageUse('ann')
	await t.grantUse(slack, 'ann')
	const applied = await t.apply('ann', 'member', [
		{ target: daily, needKey: 'chat', credentials: [{ name: 'team-slack' }] },
	])
	expect(applied.map((change) => change.error)).toEqual([null])
	// Paused at run time on a permission ann lacks (she only has Use).
	const storedPause = {
		state: 'paused',
		paused_reason: 'credential_access',
		paused_resource_type: 'credential',
		paused_resource_id: slack,
		paused_credential_id: null,
	}
	await t.db
		.prepare(
			`UPDATE enablements SET state = 'paused', paused_reason = 'credential_access',
				paused_permission = 'secret:write', paused_resource_type = 'credential',
				paused_resource_id = ?, paused_credential_id = NULL,
				paused_at = '2026-10-13T00:00:00.000Z'
			WHERE package_id = ?`,
		)
		.bind(slack, t.savedPackage.id)
		.run()
	expect((await t.plan()).runs).toEqual([])
	expect(await t.readEnablement()).toEqual(storedPause)

	await t.setDeleted(slack, true)
	expect((await t.plan()).runs).toEqual([])
	expect(await t.readEnablement()).toEqual(storedPause)

	await t.setDeleted(slack, false)
	expect((await t.plan()).runs).toEqual([])
	expect(await t.readEnablement()).toEqual(storedPause)
})

test('a corrupt trigger mapping row reads as unset and never pauses or blocks the run', async () => {
	const t = await setup()
	await t.storeKey('team-slack', 'slack')
	await t.apply('bea', 'owner', [
		{ target: daily, needKey: 'chat', credentials: [{ name: 'team-slack' }] },
	])
	await t.db
		.prepare(
			`UPDATE credential_mappings SET credential_ids_json = '{not json'
			WHERE target = 'enablement'`,
		)
		.run()
	expect((await t.plan()).runs).toHaveLength(1)
	expect((await t.readEnablement())?.state).toBe('on')
})

test('a need a republish added with no single match never pauses the trigger', async () => {
	const t = await setup()
	await t.storeKey('team-slack', 'slack')
	await t.apply('bea', 'owner', [
		{ target: daily, needKey: 'chat', credentials: [{ name: 'team-slack' }] },
	])
	vi.spyOn(needsClosure, 'loadPublishedCredentialNeeds').mockResolvedValue([
		...mappingFixtureNeeds,
		{
			key: 'calendar',
			kind: 'oauth',
			provider: 'google',
			description: 'Read the calendar',
			multiple: false,
		},
	])
	// Only the call for the new need fails (credential-client tests); the
	// trigger keeps running.
	expect((await t.plan()).runs).toHaveLength(1)
	expect((await t.readEnablement())?.state).toBe('on')
})

test('a mapping row left by a need a republish removed never pauses the trigger', async () => {
	const t = await setup()
	const slack = await t.storeKey('team-slack', 'slack')
	await t.apply('bea', 'owner', [
		{ target: daily, needKey: 'chat', credentials: [{ name: 'team-slack' }] },
	])
	vi.spyOn(needsClosure, 'loadPublishedCredentialNeeds').mockResolvedValue(
		mappingFixtureNeeds.filter((need) => need.key !== 'chat'),
	)
	await t.setDeleted(slack, true)
	expect((await t.plan()).runs).toHaveLength(1)
	expect((await t.readEnablement())?.state).toBe('on')
})

test('a pick that no longer fits its need after a republish changed the kind pauses the trigger', async () => {
	const t = await setup()
	const slack = await t.storeKey('team-slack', 'slack')
	await t.apply('bea', 'owner', [
		{ target: daily, needKey: 'chat', credentials: [{ name: 'team-slack' }] },
	])
	vi.spyOn(needsClosure, 'loadPublishedCredentialNeeds').mockResolvedValue(
		mappingFixtureNeeds.map((need) =>
			need.key === 'chat' ? { ...need, kind: 'oauth' } : need,
		),
	)
	expect((await t.plan()).runs).toEqual([])
	expect(await t.readEnablement()).toMatchObject({
		state: 'paused',
		paused_resource_type: 'credential-mapping',
		paused_resource_id: 'chat',
		paused_credential_id: slack,
	})
})

test('a paused enablement whose cause moved to another need names the new one', async () => {
	const t = await setup()
	const slack = await t.storeKey('team-slack', 'slack')
	const prod = await t.storeKey('resend-prod', 'resend')
	await t.apply('bea', 'owner', [
		{ target: daily, needKey: 'chat', credentials: [{ name: 'team-slack' }] },
		{ target: daily, needKey: 'mail', credentials: [{ name: 'resend-prod' }] },
	])
	await t.setDeleted(slack, true)
	expect((await t.plan()).runs).toEqual([])
	expect((await t.readEnablement())?.paused_resource_id).toBe('chat')

	await t.setDeleted(slack, false)
	await t.setDeleted(prod, true)
	expect((await t.plan()).runs).toEqual([])
	expect(await t.readEnablement()).toMatchObject({
		state: 'paused',
		paused_resource_id: 'mail',
		paused_credential_id: prod,
	})
})
