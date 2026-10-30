import { DatabaseSync } from 'node:sqlite'
import { ecpDefaultGrant } from '@kody-internal/shared/execution-context-protocol/index.ts'
import { expect, test } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	assertGrantAllowsSharing,
	contextIsShared,
	contextRunCredentials,
	registrationGrant,
} from './credential-grant.ts'
import {
	type ExecutionContextCaller,
	attachContext,
	setSharing,
	updateContext,
} from './service.ts'
import { getExecutionContext, parseGrant } from './store.ts'

const orgId = 'org_acme'
const operator = 'user_operator'
const now = '2026-10-30T00:00:00.000Z'

function setup(credentials: (typeof ecpDefaultGrant)['credentials']) {
	const sqlite = new DatabaseSync(':memory:', {
		enableForeignKeyConstraints: false,
	})
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	sqlite
		.prepare(
			`INSERT INTO execution_contexts (id, org_id, operator_user_id, all_members, name,
				public_key_jwk, thumbprint, created_at, grant_json, grant_version)
			 VALUES ('ec_mac', ?, ?, 0, 'mac', '{}', 'thumb', ?, ?, 1)`,
		)
		.run(
			orgId,
			operator,
			now,
			JSON.stringify({ ...ecpDefaultGrant, credentials }),
		)
	const db = createD1FromSqlite(sqlite)
	const session = {
		updateGrant: async () => {},
		recordAudit: async () => {},
		getStatus: async () => ({ online: false, acceptingRuns: false }),
		endLeases: async () => {},
	}
	const env = {
		APP_DB: db,
		EXECUTION_CONTEXT_SESSION: {
			idFromName: (n: string) => n,
			get: () => session,
		},
	} as unknown as Env
	const callerFor = (userId: string) =>
		({
			env,
			callerContext: { baseUrl: 'https://kody.test' },
			request: {
				actor: { userId, username: userId },
				org: { id: orgId, slug: 'acme' },
				membership: { role: 'member' },
			},
			userId,
			orgId,
		}) as unknown as ExecutionContextCaller
	const shareWith = (userId: string) =>
		sqlite
			.prepare(
				`INSERT INTO grants (id, org_id, resource_type, resource_id, subject_type, subject_id,
					preset, created_by_user_id, created_at, updated_at)
				 VALUES (?, ?, 'execution_context', 'ec_mac', 'user', ?, ?, ?, ?, ?)`,
			)
			.run(`grant_${userId}`, orgId, userId, 'contribute', operator, now, now)
	const grant = async () =>
		parseGrant((await getExecutionContext(db, 'ec_mac'))!)
	return {
		sqlite,
		db,
		caller: callerFor(operator),
		callerFor,
		shareWith,
		grant,
	}
}

test('new contexts start with requester credentials, values still kept on Kody', () => {
	expect(registrationGrant.credentials).toEqual({ mode: 'requester' })
	expect(registrationGrant.fs).toEqual([])
})

test('the operator can let all their credentials through an unshared context', async () => {
	const s = setup({ mode: 'none' })
	await updateContext(s.caller, 'ec_mac', {
		grant: { credentials: { mode: 'requester' } },
	})
	expect((await s.grant()).credentials).toEqual({ mode: 'requester' })
})

test('a shared context cannot be switched to requester credentials', async () => {
	const s = setup({ mode: 'none' })
	s.shareWith('user_friend')
	await expect(
		updateContext(s.caller, 'ec_mac', {
			grant: { credentials: { mode: 'requester' } },
		}),
	).rejects.toThrow(
		/is shared, so its grant cannot let every credential through/,
	)
	expect((await s.grant()).credentials).toEqual({ mode: 'none' })
})

test('only the operator can set requester credentials', async () => {
	const s = setup({ mode: 'none' })
	s.shareWith('user_friend')
	await expect(
		updateContext(s.callerFor('user_friend'), 'ec_mac', {
			grant: { credentials: { mode: 'requester' } },
		}),
	).rejects.toThrow(/Only mac's operator/)
})

test('sharing or attaching is refused while the grant lets every credential through', async () => {
	const s = setup({ mode: 'requester' })
	await expect(
		setSharing(s.caller, 'ec_mac', {
			add: [{ subject: { type: 'user', id: 'user_friend' }, preset: 'use' }],
		}),
	).rejects.toThrow(/Narrow its credentials to an explicit list/)
	await expect(
		setSharing(s.caller, 'ec_mac', { allMembers: true }),
	).rejects.toThrow(/credentials_need_unshared_context/)
	await expect(attachContext(s.caller, 'ec_mac', 'org_other')).rejects.toThrow(
		/allowed only while it is not shared/,
	)
	expect(
		await contextIsShared(s.db, (await getExecutionContext(s.db, 'ec_mac'))!),
	).toBe(false)
	expect((await s.grant()).credentials).toEqual({ mode: 'requester' })
})

test('list and none grants can still be shared', () => {
	const grants: Array<(typeof ecpDefaultGrant)['credentials']> = [
		{ mode: 'list', ids: ['cred_1'] },
		{ mode: 'none' },
	]
	for (const credentials of grants) {
		expect(() =>
			assertGrantAllowsSharing({ name: 'mac', grant: { credentials } }),
		).not.toThrow()
	}
})

test('a requester grant allows no credentials at run time once shared, or for anyone but the operator', async () => {
	const s = setup({ mode: 'requester' })
	const requester = { credentials: { mode: 'requester' } } as const
	expect(
		contextRunCredentials(requester, {
			shared: false,
			requesterIsOperator: true,
		}),
	).toEqual({ mode: 'requester' })
	s.shareWith('user_friend')
	const row = (await getExecutionContext(s.db, 'ec_mac'))!
	expect(await contextIsShared(s.db, row)).toBe(true)
	expect(
		contextRunCredentials(requester, {
			shared: await contextIsShared(s.db, row),
			requesterIsOperator: true,
		}),
	).toEqual({ mode: 'requester_shared' })
	expect(
		contextRunCredentials(requester, {
			shared: false,
			requesterIsOperator: false,
		}),
	).toEqual({ mode: 'requester_shared' })
})

test('list and none credentials are unchanged at run time', () => {
	const input = { shared: true, requesterIsOperator: false }
	expect(
		contextRunCredentials({ credentials: { mode: 'list', ids: ['c'] } }, input),
	).toEqual({ mode: 'list', ids: ['c'] })
	expect(
		contextRunCredentials({ credentials: { mode: 'list', ids: [] } }, input),
	).toEqual({ mode: 'none' })
	expect(
		contextRunCredentials({ credentials: { mode: 'none' } }, input),
	).toEqual({ mode: 'none' })
})
