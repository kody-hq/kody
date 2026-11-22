import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { createActor, createAsyncLogic, toPromise } from 'xstate'
import { expect, test } from 'vitest'
import {
	type PersonalOrgHardPurgeRelation,
	type PersonPurgeMode,
	type PersonPurgeRow,
	orgHardPurgeState,
	personHardPurgeState,
} from './hard-purge-state.ts'
import { PurgeWebhookFailed } from './purge-webhook.ts'

const orgId = 'org-1' as OwnerId
const stableUserId = 'person-1' as OwnerId

function recorder(fail?: string, failWith?: unknown) {
	const calls: Array<string> = []
	function step<T>(name: string, value: T) {
		return createAsyncLogic({
			run: async () => {
				calls.push(name)
				if (name === fail) throw failWith ?? new Error(`${name} failed`)
				return value
			},
		})
	}
	return { calls, step }
}

function purgeOrg(
	relation: PersonalOrgHardPurgeRelation,
	fail?: string,
	failWith?: unknown,
) {
	const { calls, step } = recorder(fail, failWith)
	const machine = orgHardPurgeState.provide({
		actors: {
			readPersonalOrgRelation: step('relation', relation),
			wipePinnedConnections: step('wipe', undefined),
			purgeOutOfBandSurfaces: step('out_of_band', undefined),
			postPurgeWebhook: step('webhook', undefined),
			deleteOrgData: step('delete_rows', undefined),
			auditOrgPurged: step('audit', undefined),
		},
	})
	return {
		calls,
		output: toPromise(createActor(machine, { input: { orgId } }).start()),
	}
}

test('a team org wipes pins, then out-of-band storage, then rows, then records org.purged', async () => {
	const { calls, output } = purgeOrg('none')
	expect(await output).toEqual({ status: 'purged' })
	expect(calls).toEqual([
		'relation',
		'wipe',
		'out_of_band',
		'webhook',
		'delete_rows',
		'audit',
	])
})

test('a failed org purge webhook keeps the org rows as its own failure', async () => {
	const webhookFailure = new PurgeWebhookFailed(
		{ kind: 'org', id: orgId },
		{ status: 500 },
	)
	const { calls, output } = purgeOrg('none', 'webhook', webhookFailure)
	expect(await output).toEqual({
		status: 'webhook_failed',
		error: webhookFailure,
	})
	expect(calls).toEqual(['relation', 'wipe', 'out_of_band', 'webhook'])
})

test('a personal org is refused before any write', async () => {
	const live = purgeOrg('live_person')
	expect(await live.output).toEqual({ status: 'blocked_live_person' })
	expect(live.calls).toEqual(['relation'])
	const softDeleted = purgeOrg('soft_deleted_person')
	expect(await softDeleted.output).toEqual({ status: 'purges_with_person' })
	expect(softDeleted.calls).toEqual(['relation'])
})

test('a failed org purge step stops every later step', async () => {
	const { calls, output } = purgeOrg('none', 'out_of_band')
	expect(await output).toMatchObject({ status: 'failed' })
	expect(calls).toEqual(['relation', 'wipe', 'out_of_band'])
})

function person(patch: Partial<PersonPurgeRow> = {}): PersonPurgeRow {
	return {
		stableUserId,
		storageOwnerId: orgId,
		personUserId: stableUserId,
		deletedAt: null,
		deletingAt: '2026-01-01T00:00:00.000Z',
		...patch,
	}
}

function purgePerson(input: {
	mode: PersonPurgeMode
	row: PersonPurgeRow | null
	personalOrgId?: OwnerId | null
	deletedUserRows?: number
	rowPresent?: boolean
	fail?: string
	failWith?: unknown
}) {
	const { calls, step } = recorder(input.fail, input.failWith)
	const machine = personHardPurgeState.provide({
		actors: {
			readPerson: step('read', input.row),
			tombstonePersonalOrg: step('tombstone', undefined),
			resolveSoftDeletedOrg: step(
				'resolve_org',
				input.personalOrgId === undefined ? orgId : input.personalOrgId,
			),
			wipePinnedConnections: step('wipe', undefined),
			redactAuditActors: step('redact', undefined),
			deleteAccount: step('delete_account', input.deletedUserRows ?? 1),
			deleteOrgData: step('delete_org_rows', undefined),
			auditOrgPurged: step('audit_org', undefined),
			readUserRowPresent: step('verify', input.rowPresent ?? false),
			auditUserPurged: step('audit_user', undefined),
		},
	})
	return {
		calls,
		output: toPromise(
			createActor(machine, {
				input: { mode: input.mode, dbUserId: 1, stableUserId },
			}).start(),
		),
	}
}

test('a soft-deleted person deletes its account before its personal org rows', async () => {
	const { calls, output } = purgePerson({ mode: 'soft_deleted', row: person() })
	expect(await output).toEqual({ status: 'purged', storageOwnerId: orgId })
	expect(calls).toEqual([
		'read',
		'resolve_org',
		'wipe',
		'redact',
		'delete_account',
		'delete_org_rows',
		'audit_org',
		'audit_user',
	])
})

test('a failed purge webhook inside account deletion keeps the personal org rows too', async () => {
	const webhookFailure = new PurgeWebhookFailed(
		{ kind: 'org', id: orgId },
		{ cause: new TypeError('fetch failed') },
	)
	const { calls, output } = purgePerson({
		mode: 'soft_deleted',
		row: person(),
		fail: 'delete_account',
		failWith: webhookFailure,
	})
	expect(await output).toEqual({
		status: 'webhook_failed',
		error: webhookFailure,
	})
	expect(calls).toEqual([
		'read',
		'resolve_org',
		'wipe',
		'redact',
		'delete_account',
	])
})

test('a person without a soft-deleted personal org skips the org steps', async () => {
	const { calls, output } = purgePerson({
		mode: 'soft_deleted',
		row: null,
		personalOrgId: null,
	})
	expect(await output).toEqual({
		status: 'purged',
		storageOwnerId: stableUserId,
	})
	expect(calls).toEqual([
		'read',
		'resolve_org',
		'redact',
		'delete_account',
		'audit_user',
	])
})

test('a legacy retry tombstones the personal org first and refuses rows that are not pending', async () => {
	const pending = purgePerson({ mode: 'legacy', row: person() })
	expect(await pending.output).toMatchObject({ status: 'purged' })
	expect(pending.calls.slice(0, 3)).toEqual([
		'read',
		'tombstone',
		'resolve_org',
	])
	expect(await purgePerson({ mode: 'legacy', row: null }).output).toEqual({
		status: 'already_gone',
	})
	for (const [row, reason] of [
		[person({ stableUserId: 'someone-else' }), 'id_mismatch'],
		[person({ deletedAt: '2026-01-02T00:00:00.000Z' }), 'soft_deleted'],
		[person({ deletingAt: null }), 'live'],
	] as const) {
		const refused = purgePerson({ mode: 'legacy', row })
		expect(await refused.output).toEqual({ status: 'not_pending', reason })
		expect(refused.calls).toEqual(['read'])
	}
})

test('a legacy retry whose users row survived does not record user.purged', async () => {
	const { calls, output } = purgePerson({
		mode: 'legacy',
		row: person(),
		deletedUserRows: 0,
		rowPresent: true,
	})
	expect(await output).toEqual({ status: 'row_not_removed' })
	expect(calls.at(-1)).toBe('verify')
})

test('a failed account deletion keeps the personal org rows for a later retry', async () => {
	const { calls, output } = purgePerson({
		mode: 'soft_deleted',
		row: person(),
		fail: 'delete_account',
	})
	expect(await output).toMatchObject({ status: 'failed' })
	expect(calls.at(-1)).toBe('delete_account')
})
