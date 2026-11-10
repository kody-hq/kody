/**
 * Execution context mutations are gated by a write-level permission, never
 * `execution_context:read`: a token scoped for reading contexts must not
 * attach, detach, unshare, or dismiss notices. The handlers' role checks
 * (operator only, Manage holders) still apply on top.
 */
import { DatabaseSync } from 'node:sqlite'
import type { OrgRole } from '@kody-internal/shared/request-context.ts'
import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test } from 'vitest'
import {
	executionContextAttachCapability,
	executionContextDetachCapability,
	executionContextNoticeDismissCapability,
	executionContextShareRemoveCapability,
} from '#mcp/capabilities/execution-contexts/capabilities.ts'
import { executionContextsDomain } from '#mcp/capabilities/execution-contexts/domain.ts'
import { cliLoginDeviceTokenScopes } from '#worker/api-tokens/cli-login-device-token.ts'
import {
	authorizeSurface,
	surfacePermissionList,
} from '#worker/authorization/authorize.ts'
import { deriveRequestContext } from '#worker/request-context/request-context.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	type ExecutionContextCaller,
	attachContext,
	detachContext,
	removeShare,
	setSharing,
} from './service.ts'

const orgId = 'org_acme'
const otherOrgId = 'org_other'
const operator = 'user_operator'
const manager = 'user_manager'
const user = 'user_use'
const now = '2026-11-09T00:00:00.000Z'

const mutations = {
	executionContextAttach: executionContextAttachCapability,
	executionContextDetach: executionContextDetachCapability,
	executionContextShareRemove: executionContextShareRemoveCapability,
	executionContextNoticeDismiss: executionContextNoticeDismissCapability,
}

function setup() {
	const sqlite = new DatabaseSync(':memory:', {
		enableForeignKeyConstraints: false,
	})
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	sqlite.exec(`
		INSERT INTO orgs (id, slug, access_epoch, created_at, updated_at)
			VALUES ('${orgId}', 'acme', 0, '${now}', '${now}'),
			       ('${otherOrgId}', 'other', 0, '${now}', '${now}');
		INSERT INTO org_memberships (org_id, user_id, role, created_at)
			VALUES ('${orgId}', '${operator}', 'owner', '${now}'),
			       ('${orgId}', '${manager}', 'member', '${now}'),
			       ('${orgId}', '${user}', 'member', '${now}'),
			       ('${otherOrgId}', '${operator}', 'member', '${now}'),
			       ('${otherOrgId}', '${manager}', 'member', '${now}');
		INSERT INTO execution_contexts (id, org_id, operator_user_id, all_members, name,
			public_key_jwk, thumbprint, created_at)
			VALUES ('ec_box', '${orgId}', '${operator}', 0, 'box', '{}', 'thumb_box', '${now}');
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
	const roles: Record<string, OrgRole> = {
		[operator]: 'owner',
		[manager]: 'member',
		[user]: 'member',
	}
	// A fresh request per check: effective permissions are memoized per request.
	const requestFor = (
		userId: string,
		credential:
			| { kind: 'session' }
			| { kind: 'api-token'; scopes: ReadonlyArray<string> } = {
			kind: 'session',
		},
	) =>
		deriveRequestContext({
			user: { userId: personIdFromStored(userId), username: userId },
			source:
				credential.kind === 'session'
					? { kind: 'session' }
					: { kind: 'api-token', tokenId: 'tok_test' },
			orgBinding: {
				org: { id: ownerIdFromStored(orgId), slug: 'acme' },
				role: roles[userId] ?? null,
			},
			...(credential.kind === 'api-token'
				? { scopes: credential.scopes as Array<never> }
				: {}),
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
		capability: (typeof mutations)[keyof typeof mutations],
		request: ReturnType<typeof requestFor>,
	) => authorizeSurface({ env, request }, capability.orgPermission)
	return { sqlite, env, requestFor, callerFor, surface }
}

test('no execution context or chain mutation is gated by execution_context:read', () => {
	const readGatedMutations = executionContextsDomain.capabilities
		.filter((capability) => capability.readOnly !== true)
		.filter((capability) =>
			surfacePermissionList(capability.orgPermission).includes(
				'execution_context:read',
			),
		)
		.map((capability) => capability.name)
	expect(readGatedMutations).toEqual([])
	expect(
		Object.fromEntries(
			Object.entries(mutations).map(([name, capability]) => [
				name,
				capability.orgPermission,
			]),
		),
	).toEqual({
		executionContextAttach: 'execution_context:manage_access',
		executionContextDetach: 'execution_context:manage_access',
		executionContextShareRemove: 'execution_context:manage_access',
		executionContextNoticeDismiss: 'execution_context:execute',
	})
})

test('a token scoped only for execution_context:read cannot reach the mutations', async () => {
	const { requestFor, surface } = setup()
	const readOnlyToken = {
		kind: 'api-token',
		scopes: ['execution_context:read'],
	} as const
	for (const capability of Object.values(mutations)) {
		await expect(
			surface(capability, requestFor(operator, readOnlyToken)),
		).rejects.toMatchObject({ code: 'credential_scope' })
	}
})

test('a kody login token carries every scope the mutations need', async () => {
	const { requestFor, surface } = setup()
	const loginToken = {
		kind: 'api-token',
		scopes: cliLoginDeviceTokenScopes,
	} as const
	for (const capability of Object.values(mutations)) {
		await expect(
			surface(capability, requestFor(operator, loginToken)),
		).resolves.toBe(undefined)
	}
})

test('a Use share may dismiss its notice; only Manage passes the sharing mutations', async () => {
	const { requestFor, callerFor, surface } = setup()
	await setSharing(callerFor(operator), 'ec_box', {
		add: [
			{ subject: { type: 'user', id: user }, preset: 'use' },
			{ subject: { type: 'user', id: manager }, preset: 'manage' },
		],
	})
	await expect(
		surface(executionContextNoticeDismissCapability, requestFor(user)),
	).resolves.toBe(undefined)
	for (const capability of [
		executionContextAttachCapability,
		executionContextDetachCapability,
		executionContextShareRemoveCapability,
	]) {
		await expect(surface(capability, requestFor(user))).rejects.toMatchObject({
			code: 'missing_permission',
		})
		await expect(surface(capability, requestFor(manager))).resolves.toBe(
			undefined,
		)
	}
})

test('the role checks still apply behind the surface permission', async () => {
	const { sqlite, callerFor } = setup()
	await setSharing(callerFor(operator), 'ec_box', {
		add: [
			{ subject: { type: 'user', id: user }, preset: 'use' },
			{ subject: { type: 'user', id: manager }, preset: 'manage' },
		],
	})
	const useGrant = sqlite
		.prepare(
			`SELECT id FROM grants WHERE resource_type = 'execution_context' AND subject_id = ? AND deleted_at IS NULL`,
		)
		.get(user) as { id: string } | undefined
	expect(useGrant).toBeDefined()

	// Attach is operator only, even for a Manage holder.
	await expect(
		attachContext(callerFor(manager), 'ec_box', otherOrgId),
	).rejects.toMatchObject({ code: 'not_granted' })
	// Detach from another org needs the operator or a manager in that org.
	sqlite.exec(`
		INSERT INTO execution_context_org_attachments (context_id, org_id, attached_by_user_id, all_members, created_at)
			VALUES ('ec_box', '${otherOrgId}', '${operator}', 0, '${now}');
	`)
	await expect(
		detachContext(callerFor(manager), 'ec_box', otherOrgId),
	).rejects.toMatchObject({ code: 'not_granted' })
	// Removing a share needs Manage (or org Owner).
	await expect(
		removeShare(callerFor(user), 'ec_box', useGrant!.id),
	).rejects.toMatchObject({ code: 'not_granted' })

	await expect(
		attachContext(callerFor(operator), 'ec_box', otherOrgId),
	).resolves.toMatchObject({ id: 'ec_box' })
	await expect(
		removeShare(callerFor(manager), 'ec_box', useGrant!.id),
	).resolves.toMatchObject({ id: 'ec_box' })
	await expect(
		detachContext(callerFor(operator), 'ec_box', otherOrgId),
	).resolves.toMatchObject({ detached: true })
})
