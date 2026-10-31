import { DatabaseSync } from 'node:sqlite'
import { ecpDefaultGrant } from '@kody-internal/shared/execution-context-protocol/index.ts'
import { expect, test } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { isOperatorContextRun } from './credential-grant.ts'
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

function setup() {
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
		.run(orgId, operator, now, JSON.stringify(ecpDefaultGrant))
	const db = createD1FromSqlite(sqlite)
	const session = {
		updateGrant: async () => {},
		recordAudit: async () => {},
		getStatus: async () => ({ online: false, acceptingRuns: false }),
		endLeases: async () => {},
	}
	const env = {
		APP_DB: db,
		AUDIT_DB: db,
		EXECUTION_CONTEXT_SESSION: {
			idFromName: (n: string) => n,
			get: () => session,
		},
	} as unknown as Env
	const callerFor = (userId: string) => {
		const request = {
			actor: { userId, username: userId },
			org: { id: orgId, slug: 'acme' },
			membership: { role: 'member' },
			credential: { kind: 'session', id: null },
		}
		return {
			env,
			callerContext: { baseUrl: 'https://kody.test', request },
			request,
			userId,
			orgId,
		} as unknown as ExecutionContextCaller
	}
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

test('only the requester who operates a context counts as its operator', () => {
	expect(
		isOperatorContextRun({
			operatorUserId: operator,
			requesterUserId: operator,
		}),
	).toBe(true)
	expect(
		isOperatorContextRun({
			operatorUserId: operator,
			requesterUserId: 'user_friend',
		}),
	).toBe(false)
})

test('a context can be shared and attached with no credential narrowing first', async () => {
	const s = setup()
	await setSharing(s.caller, 'ec_mac', {
		add: [{ subject: { type: 'user', id: 'user_friend' }, preset: 'use' }],
	})
	await setSharing(s.caller, 'ec_mac', { allMembers: true })
	await attachContext(s.caller, 'ec_mac', 'org_other').catch((error) => {
		expect(String(error)).not.toMatch(/credential/i)
	})
	expect(await s.grant()).not.toHaveProperty('credentials')
})

test('a grant update keeps the grant free of credential settings', async () => {
	const s = setup()
	await updateContext(s.caller, 'ec_mac', {
		grant: { egress: { mode: 'none' } },
	})
	expect(await s.grant()).toEqual({
		...ecpDefaultGrant,
		egress: { ...ecpDefaultGrant.egress, mode: 'none' },
	})
})
