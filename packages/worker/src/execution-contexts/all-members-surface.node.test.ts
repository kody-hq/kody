/**
 * allMembers Use (and team Use shares) must pass the dispatch surface check
 * for execution_context:read / :execute without making either an org-wide
 * grant: compiled access derives per-context Use from `all_members`.
 */
import { DatabaseSync } from 'node:sqlite'
import type { OrgRole } from '@kody-internal/shared/request-context.ts'
import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test } from 'vitest'
import { compileAccessForRequest } from '#worker/authorization/access-compile.ts'
import { authorizeSurface } from '#worker/authorization/authorize.ts'
import { deriveRequestContext } from '#worker/request-context/request-context.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	type ExecutionContextCaller,
	detachContext,
	setSharing,
} from './service.ts'

const orgId = 'org_acme'
const homeOrgId = 'org_home'
const operator = 'user_operator'
const member = 'user_member'
const teammate = 'user_teammate'
const now = '2026-11-06T00:00:00.000Z'

function setup() {
	const sqlite = new DatabaseSync(':memory:', {
		enableForeignKeyConstraints: false,
	})
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	sqlite.exec(`
		INSERT INTO orgs (id, slug, access_epoch, created_at, updated_at)
			VALUES ('${orgId}', 'acme', 0, '${now}', '${now}'),
			       ('${homeOrgId}', 'home', 0, '${now}', '${now}');
		INSERT INTO org_memberships (org_id, user_id, role, created_at)
			VALUES ('${orgId}', '${operator}', 'member', '${now}'),
			       ('${orgId}', '${member}', 'member', '${now}'),
			       ('${orgId}', '${teammate}', 'member', '${now}'),
			       ('${homeOrgId}', '${operator}', 'owner', '${now}');
		INSERT INTO execution_contexts (id, org_id, operator_user_id, all_members, name,
			public_key_jwk, thumbprint, created_at)
			VALUES ('ec_shared', '${orgId}', '${operator}', 0, 'shared', '{}', 'thumb_shared', '${now}'),
			       ('ec_home', '${homeOrgId}', '${operator}', 0, 'home', '{}', 'thumb_home', '${now}');
		INSERT INTO teams (id, org_id, slug, name, created_at, updated_at)
			VALUES ('team_core', '${orgId}', 'core', 'Core', '${now}', '${now}');
		INSERT INTO team_members (team_id, user_id, created_at)
			VALUES ('team_core', '${teammate}', '${now}');
	`)
	const db = createD1FromSqlite(sqlite)
	const session = {
		recordAudit: async () => {},
		endLeases: async () => {},
		getStatus: async () => ({ online: false, acceptingRuns: false }),
	}
	const env = {
		APP_DB: db,
		AUDIT_DB: db,
		EXECUTION_CONTEXT_SESSION: {
			idFromName: (name: string) => name,
			get: () => session,
		},
	} as unknown as Env
	// A fresh request per check: effective permissions are memoized per request.
	const requestFor = (userId: string, role: OrgRole | null = 'member') =>
		deriveRequestContext({
			user: { userId: personIdFromStored(userId), username: userId },
			source: { kind: 'session' },
			orgBinding: {
				org: { id: ownerIdFromStored(orgId), slug: 'acme' },
				role,
			},
		})
	const callerFor = (userId: string) => {
		const request = requestFor(userId)
		return {
			env,
			callerContext: { baseUrl: 'https://kody.test', request },
			request,
			userId,
			orgId,
		} as unknown as ExecutionContextCaller
	}
	const surface = (
		userId: string,
		permission:
			| 'execution_context:read'
			| 'execution_context:execute'
			| 'execution_context:write',
		role: OrgRole | null = 'member',
	) => authorizeSurface({ env, request: requestFor(userId, role) }, permission)
	return { sqlite, db, env, requestFor, callerFor, surface }
}

test('turning on allMembers lets every Member pass the read and execute surface checks', async () => {
	const { callerFor, surface } = setup()
	// Warm the access cache before the toggle: the toggle must invalidate it.
	await expect(surface(member, 'execution_context:read')).rejects.toMatchObject(
		{ code: 'missing_permission' },
	)

	await setSharing(callerFor(operator), 'ec_shared', { allMembers: true })

	await expect(surface(member, 'execution_context:read')).resolves.toBe(
		undefined,
	)
	await expect(surface(member, 'execution_context:execute')).resolves.toBe(
		undefined,
	)
	// Use only: Contribute's write stays with explicit grants.
	await expect(
		surface(member, 'execution_context:write'),
	).rejects.toMatchObject({ code: 'missing_permission' })
	// Outside collaborators are not members, so allMembers does not reach them.
	await expect(
		surface('user_outsider', 'execution_context:read', null),
	).rejects.toMatchObject({ code: 'missing_permission' })

	await setSharing(callerFor(operator), 'ec_shared', { allMembers: false })
	await expect(surface(member, 'execution_context:read')).rejects.toMatchObject(
		{ code: 'missing_permission' },
	)
})

test('allMembers is per context, never an org-wide execution_context:read', async () => {
	const { sqlite, requestFor, db } = setup()
	sqlite.exec(
		`UPDATE execution_contexts SET all_members = 1 WHERE id = 'ec_shared'`,
	)
	const compiled = await compileAccessForRequest({
		db,
		request: requestFor(member),
	})
	expect(compiled.orgPermissions.has('execution_context:read')).toBe(false)
	expect([
		...(compiled.resourcePermissions.get('execution_context:ec_shared') ?? []),
	]).toEqual(['execution_context:read', 'execution_context:execute'])
	expect(compiled.resourcePermissions.has('execution_context:ec_home')).toBe(
		false,
	)
})

test('an allMembers attachment from another org passes until it is detached', async () => {
	const { sqlite, callerFor, surface } = setup()
	sqlite.exec(`
		INSERT INTO execution_context_org_attachments (context_id, org_id, attached_by_user_id, all_members, created_at)
			VALUES ('ec_home', '${orgId}', '${operator}', 1, '${now}');
	`)
	await expect(surface(member, 'execution_context:read')).resolves.toBe(
		undefined,
	)

	await detachContext(callerFor(operator), 'ec_home', orgId)

	await expect(surface(member, 'execution_context:read')).rejects.toMatchObject(
		{ code: 'missing_permission' },
	)
})

test('a team Use share passes the surface check for team members only', async () => {
	const { callerFor, surface } = setup()
	await setSharing(callerFor(operator), 'ec_shared', {
		add: [{ subject: { type: 'team', id: 'team_core' }, preset: 'use' }],
	})
	await expect(surface(teammate, 'execution_context:read')).resolves.toBe(
		undefined,
	)
	await expect(surface(teammate, 'execution_context:execute')).resolves.toBe(
		undefined,
	)
	await expect(surface(member, 'execution_context:read')).rejects.toMatchObject(
		{ code: 'missing_permission' },
	)
})

test('access cached before allMembers was compiled recompiles', async () => {
	const { sqlite, db, requestFor, surface } = setup()
	sqlite.exec(
		`UPDATE execution_contexts SET all_members = 1 WHERE id = 'ec_shared'`,
	)
	// A row an older Worker wrote at the current epoch, without the format.
	sqlite
		.prepare(
			`INSERT INTO access_cache (org_id, user_id, epoch, compiled_json, computed_at, valid_until)
			 VALUES (?, ?, 0, ?, ?, NULL)`,
		)
		.run(
			orgId,
			member,
			JSON.stringify({
				isOwner: false,
				orgPermissions: ['org:read'],
				resourcePermissions: {},
				unmappableChangesAllowed: [],
			}),
			now,
		)
	await expect(surface(member, 'execution_context:read')).resolves.toBe(
		undefined,
	)
	const compiled = await compileAccessForRequest({
		db,
		request: requestFor(member),
	})
	expect(
		compiled.resourcePermissions.get('execution_context:ec_shared'),
	).toBeDefined()
})
