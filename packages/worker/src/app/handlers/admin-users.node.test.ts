import {
	type AdminUsersMutationData,
	type AdminUsersLoaderData,
} from '#universal/loader-data.ts'
import { type PermissionString, type RoleName } from '#universal/permissions.ts'
import type * as UsersData from '#worker/admin/users-data.ts'
import { adminUserListItemFieldNames } from '#worker/admin/users-data.ts'
import type * as AuditLog from '#worker/audit-log.ts'
import * as AdminUserCreation from '#worker/identity/admin-user-creation.ts'
import { adminOperationOutcome } from '#worker/test-support/admin-operation-outcome.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { logAuditEventSpy } from '#worker/test-support/audit-log-spy.ts'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'

const mockModule = vi.hoisted(() => ({
	readAuthenticatedAppUser: vi.fn(),
	adminCreateUserWithPasswordSetup: vi.fn(),
	scheduleUserCreatedEvent: vi.fn(),
	loadAdminUsersData: undefined as
		| ((...args: Array<unknown>) => Promise<unknown>)
		| undefined,
}))

vi.mock('#app/authenticated-user.ts', () => ({
	readAuthenticatedAppUser: (...args: Array<unknown>) =>
		mockModule.readAuthenticatedAppUser(...args),
}))

vi.mock('#worker/identity/admin-user-creation.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof AdminUserCreation>()
	return {
		...actual,
		adminCreateUserWithPasswordSetup: (...args: Array<unknown>) =>
			mockModule.adminCreateUserWithPasswordSetup(...args),
	}
})

vi.mock('#worker/identity/schedule-user-lifecycle-event.ts', () => ({
	scheduleUserCreatedEvent: (...args: Array<unknown>) =>
		mockModule.scheduleUserCreatedEvent(...args),
}))

vi.mock('#worker/admin/users-data.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof UsersData>()
	return {
		...actual,
		loadAdminUsersData: (
			...args: Parameters<typeof actual.loadAdminUsersData>
		) =>
			mockModule.loadAdminUsersData
				? mockModule.loadAdminUsersData(...args)
				: actual.loadAdminUsersData(...args),
	}
})

// The shared audit-log-spy setup file routes logAuditEvent; this test also
// needs a deterministic request IP for its audit assertions.
vi.mock('#worker/audit-log.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof AuditLog>()
	return {
		...actual,
		getRequestIp: () => '127.0.0.1',
		logAuditEvent: (...args: Parameters<typeof actual.logAuditEvent>) =>
			logAuditEventSpy(...args),
	}
})

type UserRow = {
	id: number
	username: string
	email: string
	email_verified_at?: string | null
	plan?: string
	stripe_plan?: string | null
	stripe_customer_id?: string | null
	suspended_at?: string | null
	email_outbound_paused_at?: string | null
	email_verification_delivery_status?: string | null
	email_verification_delivery_at?: string | null
	email_verification_delivery_detail?: string | null
	email_verification_delivery_class?: string | null
	second_agent_standard_gift_expires_at?: string | null
	referral_standard_credit_expires_at?: string | null
	created_at: string
	updated_at: string
}

function stableUserId(id: number) {
	return id.toString(16).padStart(64, '0')
}

function createAdminActor(roles: Array<RoleName>) {
	const permissions: Array<PermissionString> = roles.includes('admin')
		? ['read:user:any', 'update:user:any']
		: ['read:user:own']
	return {
		sessionUserId: '1',
		userId: 1,
		email: 'admin@example.com',
		username: 'admin-user',
		displayName: 'admin-user',
		roles,
		permissions,
		artifactOwnerIds: ['1'],
		mcpUser: {
			userId: stableUserId(1),
			email: 'admin@example.com',
			username: 'admin-user',
			displayName: 'admin-user',
		},
	}
}

function createAdminTestEnv(input: {
	users: Array<UserRow>
	userRoles: Array<[number, RoleName]>
}) {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../../migrations/', import.meta.url))
	for (const user of input.users) {
		const {
			plan,
			stripe_plan,
			stripe_customer_id,
			email_outbound_paused_at,
			second_agent_standard_gift_expires_at,
			referral_standard_credit_expires_at,
			...identity
		} = user
		const stableUser = stableUserId(user.id)
		const row = {
			password_hash: 'test-password-hash',
			stable_user_id: stableUser,
			...identity,
		}
		const columns = Object.keys(row)
		sqlite
			.prepare(
				`INSERT INTO users (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
			)
			.run(...Object.values(row))
		sqlite
			.prepare(
				`INSERT INTO orgs (
					id, slug, plan, stripe_plan, stripe_customer_id,
					email_outbound_paused_at, second_agent_standard_gift_expires_at,
					referral_standard_credit_expires_at, created_at, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				stableUser,
				user.username,
				plan ?? 'free',
				stripe_plan ?? null,
				stripe_customer_id ?? null,
				email_outbound_paused_at ?? null,
				second_agent_standard_gift_expires_at ?? null,
				referral_standard_credit_expires_at ?? null,
				user.created_at,
				user.updated_at,
			)
	}
	for (const [userId, role] of input.userRoles) {
		sqlite
			.prepare(
				`INSERT INTO user_roles (user_id, role_id) SELECT ?, id FROM roles WHERE name = ?`,
			)
			.run(userId, role)
	}
	return { COOKIE_SECRET: 'secret', APP_DB: createD1FromSqlite(sqlite) }
}
const userOperations = await import('#worker/admin/users-operations.ts')

function makeUser(
	id: number,
	username: string,
	overrides: Partial<UserRow> = {},
): UserRow {
	return {
		id,
		username,
		email: `${username}@example.com`,
		created_at: '2026-01-01 00:00:00',
		updated_at: '2026-01-02 00:00:00',
		...overrides,
	}
}

function setupAdminUsers(
	users: Array<UserRow>,
	userRoles: Array<[number, RoleName]>,
	actorRoles: Array<RoleName> = ['admin'],
) {
	mockModule.readAuthenticatedAppUser.mockResolvedValue(
		createAdminActor(actorRoles),
	)
	const env = createAdminTestEnv({ users, userRoles })
	const send = (search: string, body?: Record<string, unknown>) =>
		adminOperationOutcome(async () => {
			const url = new URL(`https://example.com/admin/users.json${search}`)
			const request = new Request(url, {
				headers: { Accept: 'application/json' },
			})
			if (body) {
				switch (body.action) {
					case 'assign_role':
						return userOperations.assignAdminUserRole({
							env: env as unknown as Env,
							request,
							...body,
						})
					case 'remove_role':
						return userOperations.removeAdminUserRole({
							env: env as unknown as Env,
							request,
							...body,
						})
					case 'update_plan':
						return userOperations.setAdminUserPlan({
							env: env as unknown as Env,
							request,
							...body,
						})
					case 'suspend_user':
						return userOperations.setAdminUserSuspension({
							env: env as unknown as Env,
							request,
							...body,
							suspended: true,
						})
					case 'unsuspend_user':
						return userOperations.setAdminUserSuspension({
							env: env as unknown as Env,
							request,
							...body,
							suspended: false,
						})
					case 'resume_email_outbound':
						return userOperations.resumeAdminUserEmail({
							env: env as unknown as Env,
							request,
							...body,
						})
					case 'mark_email_verified':
						return userOperations.verifyAdminUserEmail({
							env: env as unknown as Env,
							request,
							...body,
						})
					case 'mint_verify_url':
						return userOperations.mintAdminUserVerificationUrl({
							env: env as unknown as Env,
							request,
							...body,
						})
					case 'mark_email_destination_verified':
						return userOperations.verifyAdminUserEmailDestination({
							env: env as unknown as Env,
							request,
							...body,
						})
					case 'create_user':
						return userOperations.createAdminUser({
							env: env as unknown as Env,
							request,
							...body,
						})
					default:
						throw new Error('Unsupported admin user fixture action')
				}
			}
			const { requireUserWithPermission } =
				await import('#app/permissions-server.ts')
			await requireUserWithPermission(
				request,
				env as unknown as Env,
				'read:user:any',
			)
			const { loadAdminUsersData } = await import('#worker/admin/users-data.ts')
			return loadAdminUsersData(env as unknown as Env, url.toString())
		})

	return {
		env,
		get: (search = '') => send(search),
		post: (body: Record<string, unknown>, search = '') => send(search, body),
		list: async (search: string) => {
			const response = await send(search)
			expect(response.status).toBe(200)
			return (await Promise.resolve(response.data)) as AdminUsersLoaderData
		},
	}
}

const stableIds = (payload: { users: Array<{ stableUserId: string }> }) =>
	payload.users.map((user) => user.stableUserId)

function expectAdminAudit(action: string, reason?: string) {
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			category: 'admin',
			action,
			result: 'success',
			...(reason === undefined ? {} : { reason }),
		}),
	)
}

test('admin users list payload exposes only account metadata fields', async () => {
	const { get } = setupAdminUsers(
		[
			makeUser(1, 'admin-user', {
				email: 'admin@example.com',
				email_verified_at: '2026-01-01T00:00:00.000Z',
				plan: 'pro',
			}),
			makeUser(2, 'member', {
				email_verified_at: null,
				plan: 'free',
				stripe_plan: 'standard',
				stripe_customer_id: 'cus_member',
			}),
		],
		[
			[1, 'admin'],
			[2, 'user'],
		],
	)

	const response = await get()

	expect(response.status).toBe(200)
	const payload = (await Promise.resolve(response.data)) as AdminUsersLoaderData
	expect(Object.keys(payload).sort()).toEqual(
		[
			'availablePlans',
			'availableRoles',
			'ok',
			'page',
			'pageSize',
			'selectedUser',
			'total',
			'users',
		].sort(),
	)
	expect(payload.selectedUser).toBeNull()
	for (const user of payload.users) {
		expect(Object.keys(user).sort()).toEqual(
			[...adminUserListItemFieldNames].sort(),
		)
	}
	expect(payload.users).toEqual([
		expect.objectContaining({
			email: 'admin@example.com',
			email_verified: true,
			email_verified_at: '2026-01-01T00:00:00.000Z',
			plan: 'pro',
			manualPlan: 'pro',
			stripePlan: null,
			effectivePlan: 'pro',
			secondAgentGiftExpiresAt: null,
			referralCreditExpiresAt: null,
			overlayExpiresAt: null,
			isProOverlay: false,
			overlayType: null,
			stripeCustomerLinked: false,
		}),
		expect.objectContaining({
			email: 'member@example.com',
			email_verified: false,
			email_verified_at: null,
			plan: 'free',
			manualPlan: 'free',
			stripePlan: 'standard',
			effectivePlan: 'standard',
			secondAgentGiftExpiresAt: null,
			referralCreditExpiresAt: null,
			overlayExpiresAt: null,
			isProOverlay: false,
			overlayType: null,
			stripeCustomerLinked: true,
		}),
	])
})

test('admin users list exposes temporary Pro gift overlay fields for Package filters', async () => {
	const giftExpiresAt = '2099-01-10T00:00:00.000Z'
	const referralExpiresAt = '2099-01-20T00:00:00.000Z'
	const { list } = setupAdminUsers(
		[
			makeUser(1, 'admin-user', { email: 'admin@example.com' }),
			makeUser(2, 'continuumpraxis', {
				email: 'continuum@example.com',
				plan: 'free',
				second_agent_standard_gift_expires_at: giftExpiresAt,
				referral_standard_credit_expires_at: referralExpiresAt,
			}),
		],
		[
			[1, 'admin'],
			[2, 'user'],
		],
	)

	const payload = await list('')
	expect(payload.users).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				username: 'continuumpraxis',
				plan: 'free',
				effectivePlan: 'pro',
				secondAgentGiftExpiresAt: giftExpiresAt,
				referralCreditExpiresAt: referralExpiresAt,
				overlayExpiresAt: referralExpiresAt,
				isProOverlay: true,
				overlayType: 'referral_credit',
			}),
		]),
	)
})

test('admin users list applies selected, q, role, and pagination filters', async () => {
	const { list } = setupAdminUsers(
		[
			makeUser(1, 'admin-user', { email: 'admin@example.com' }),
			makeUser(2, 'searchable-member', { email: 'member@example.com' }),
			makeUser(3, 'another-member', { email: 'searchable@example.com' }),
		],
		[
			[1, 'admin'],
			[2, 'user'],
			[3, 'user'],
		],
	)

	// Selected user on a later page is still returned for the detail pane.
	const paged = await list(`?pageSize=1&page=1&selected=${stableUserId(3)}`)
	expect(stableIds(paged)).toEqual([stableUserId(1)])
	expect(paged.selectedUser).toEqual(
		expect.objectContaining({
			stableUserId: stableUserId(3),
			username: 'another-member',
			email: 'searchable@example.com',
		}),
	)

	// Selected user excluded by the active role filter is still returned.
	const filtered = await list(`?role=admin&selected=${stableUserId(2)}`)
	expect(stableIds(filtered)).toEqual([stableUserId(1)])
	expect(filtered.selectedUser).toEqual(
		expect.objectContaining({
			stableUserId: stableUserId(2),
			username: 'searchable-member',
		}),
	)

	expect((await list(`?selected=${stableUserId(99)}`)).selectedUser).toBeNull()
	expect((await list('?selected=123')).selectedUser).toBeNull()

	// q matches username or email; total reflects the filtered set. Unknown
	// role values are ignored rather than filtering everything out, and
	// filters compose with pagination.
	const cases: Array<[string, number, Array<number>]> = [
		['?q=searchable', 2, [2, 3]],
		['?role=admin', 1, [1]],
		['?q=searchable&role=admin', 0, []],
		['?role=not-a-role', 3, [1, 2, 3]],
		['?q=searchable&pageSize=1&page=2', 2, [3]],
	]
	for (const [search, total, ids] of cases) {
		const payload = await list(search)
		expect([search, payload.total, stableIds(payload)]).toEqual([
			search,
			total,
			ids.map(stableUserId),
		])
	}
})

test('admin users list applies verification=stalled to the slice and total', async () => {
	const staleAt = '2020-01-01T00:00:00.000Z'
	const { list } = setupAdminUsers(
		[
			makeUser(1, 'stalled-raul', {
				email_verified_at: null,
				email_verification_delivery_status: 'accepted',
				email_verification_delivery_at: staleAt,
			}),
			makeUser(2, 'fresh-accepted', {
				email_verified_at: null,
				email_verification_delivery_status: 'accepted',
				email_verification_delivery_at: new Date().toISOString(),
			}),
			makeUser(3, 'bounced', {
				email_verified_at: null,
				email_verification_delivery_status: 'bounced',
				email_verification_delivery_at: staleAt,
			}),
			makeUser(4, 'already-verified', {
				email_verified_at: '2026-01-01T00:00:00.000Z',
				email_verification_delivery_status: 'accepted',
				email_verification_delivery_at: staleAt,
			}),
		],
		[
			[1, 'user'],
			[2, 'user'],
			[3, 'user'],
			[4, 'user'],
		],
	)

	const payload = await list('?verification=stalled')
	expect(payload.total).toBe(1)
	expect(
		payload.users.map((user: { username: string }) => user.username),
	).toEqual(['stalled-raul'])

	expect((await list('?verification=not-a-filter')).total).toBe(4)
})

test('assign role action updates user roles and logs audit event', async () => {
	const { post } = setupAdminUsers([makeUser(2, 'member')], [[2, 'user']])

	const response = await post({
		action: 'assign_role',
		stableUserId: stableUserId(2),
		role: 'admin',
	})

	expect(response.status).toBe(200)
	const payload = (await Promise.resolve(
		response.data,
	)) as AdminUsersMutationData
	expect(payload.updatedUser?.roles).toContain('admin')
	expect(payload.updatedUser).toEqual(
		expect.objectContaining({
			stableUserId: stableUserId(2),
			roles: expect.arrayContaining(['admin', 'user']),
		}),
	)
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({ category: 'admin', action: 'assign_role' }),
	)
})

test('role writes do not reload the admin list', async () => {
	const { post } = setupAdminUsers([makeUser(2, 'member')], [[2, 'user']])
	const listRead = vi.fn(async () => {
		throw new Error('list unavailable')
	})
	mockModule.loadAdminUsersData = listRead
	try {
		const response = await post(
			{ action: 'assign_role', stableUserId: stableUserId(2), role: 'admin' },
			'?q=unrelated&page=4',
		)
		expect(response.status).toBe(200)
		expect(response.data).toEqual({
			ok: true,
			updatedUser: expect.objectContaining({
				stableUserId: stableUserId(2),
				roles: expect.arrayContaining(['admin']),
			}),
		})
		expect(listRead).not.toHaveBeenCalled()
	} finally {
		mockModule.loadAdminUsersData = undefined
	}
})

test('remove role rejects the last admin and removes admin when another admin remains', async () => {
	const removeAdmin = (id: number) => ({
		action: 'remove_role',
		stableUserId: stableUserId(id),
		role: 'admin',
	})
	const solo = setupAdminUsers([makeUser(1, 'solo-admin')], [[1, 'admin']])
	expect((await solo.post(removeAdmin(1))).status).toBe(409)

	const { post } = setupAdminUsers(
		[makeUser(1, 'first-admin'), makeUser(2, 'second-admin')],
		[
			[1, 'admin'],
			[2, 'admin'],
			[2, 'user'],
		],
	)
	const response = await post(removeAdmin(2))

	expect(response.status).toBe(200)
	const payload = (await Promise.resolve(
		response.data,
	)) as AdminUsersMutationData
	const secondAdmin = payload.updatedUser
	if (!secondAdmin) throw new Error('Expected second admin in payload')
	expect(secondAdmin.roles).not.toContain('admin')
	expectAdminAudit('remove_role')
})

test('update plan action sets, maps null to free, validates, and scopes plan changes', async () => {
	const { post } = setupAdminUsers(
		[makeUser(2, 'member', { plan: 'max' })],
		[[2, 'user']],
	)
	const target = stableUserId(2)

	const setPlanResponse = await post({
		action: 'update_plan',
		stableUserId: target,
		plan: 'pro',
	})
	expect(setPlanResponse.status).toBe(200)
	expect(
		((await Promise.resolve(setPlanResponse.data)) as AdminUsersMutationData)
			.updatedUser?.plan,
	).toBe('pro')
	expectAdminAudit('update_plan', `target_stable_user_id=${target};plan=pro`)

	const clearPlanResponse = await post({
		action: 'update_plan',
		stableUserId: target,
		plan: null,
	})
	expect(clearPlanResponse.status).toBe(200)
	expect(
		((await Promise.resolve(clearPlanResponse.data)) as AdminUsersMutationData)
			.updatedUser?.plan,
	).toBe('free')
	expectAdminAudit('update_plan', `target_stable_user_id=${target};plan=free`)

	for (const body of [
		{ action: 'update_plan', stableUserId: target, plan: 'enterprise' },
		{ action: 'update_plan', stableUserId: target },
		{ action: 'update_plan', stableUserId: 2, plan: 'pro' },
	]) {
		expect((await post(body)).status).toBe(400)
	}

	const missingUserResponse = await post({
		action: 'update_plan',
		stableUserId: stableUserId(42),
		plan: 'pro',
	})
	expect(missingUserResponse.status).toBe(404)
})

test('suspend, unsuspend, and resume email actions update flags and log audit events', async () => {
	const { post } = setupAdminUsers(
		[
			makeUser(2, 'member', {
				email_outbound_paused_at: '2026-07-20T00:00:00.000Z',
			}),
		],
		[[2, 'user']],
	)
	const targetReason = `target_stable_user_id=${stableUserId(2)}`
	const act = (action: string, id = 2) =>
		post({ action, stableUserId: stableUserId(id) })

	const suspendResponse = await act('suspend_user')
	expect(suspendResponse.status).toBe(200)
	expect(
		((await Promise.resolve(suspendResponse.data)) as AdminUsersMutationData)
			.updatedUser?.suspended_at,
	).toBeTruthy()
	expectAdminAudit('suspend_user', targetReason)

	const unsuspendResponse = await act('unsuspend_user')
	expect(unsuspendResponse.status).toBe(200)
	expect(
		((await Promise.resolve(unsuspendResponse.data)) as AdminUsersMutationData)
			.updatedUser?.suspended_at,
	).toBeNull()
	expectAdminAudit('unsuspend_user', targetReason)

	const resumeResponse = await act('resume_email_outbound')
	expect(resumeResponse.status).toBe(200)
	expect(
		((await Promise.resolve(resumeResponse.data)) as AdminUsersMutationData)
			.updatedUser?.email_outbound_paused_at,
	).toBeNull()
	expectAdminAudit('resume_email_outbound', targetReason)

	expect((await act('suspend_user', 42)).status).toBe(404)

	// Admins cannot suspend their own account (actor id is 1).
	const self = setupAdminUsers(
		[makeUser(1, 'admin-user', { email: 'admin@example.com' })],
		[[1, 'admin']],
	)
	const selfResponse = await self.post({
		action: 'suspend_user',
		stableUserId: stableUserId(1),
	})
	expect(selfResponse.status).toBe(400)
})

test('admin users API returns 403 without read:user:any permission', async () => {
	const { get } = setupAdminUsers([], [], ['user'])
	expect((await get()).status).toBe(403)
})

test('mark email verified and mint verify url actions update the account and log audit events', async () => {
	const { post } = setupAdminUsers(
		[
			makeUser(2, 'member', {
				email_verified_at: null,
				email_verification_delivery_status: 'bounced',
				email_verification_delivery_class: 'sender_block',
				email_verification_delivery_detail:
					'451 4.7.1 Data command rejected: kody.codes is blacklisted - RLR613',
			}),
		],
		[[2, 'user']],
	)
	const targetReason = `target_stable_user_id=${stableUserId(2)}`
	const act = (action: string) =>
		post({ action, stableUserId: stableUserId(2) })

	const mintResponse = await act('mint_verify_url')
	expect(mintResponse.status).toBe(200)
	const minted = (await Promise.resolve(
		mintResponse.data,
	)) as AdminUsersMutationData
	expect(minted.verifyUrl).toMatch(
		/^https:\/\/example.com\/verify-email\?token=/,
	)
	expect(minted.updatedUser?.email_verified).toBe(false)
	expectAdminAudit('mint_verify_url', targetReason)

	const verifyResponse = await act('mark_email_verified')
	expect(verifyResponse.status).toBe(200)
	const verified = (await Promise.resolve(
		verifyResponse.data,
	)) as AdminUsersMutationData
	expect(verified.updatedUser?.email_verified).toBe(true)
	expect(verified.updatedUser?.email_verification_delivery).toBeNull()
	expectAdminAudit('mark_email_verified', targetReason)

	expect((await act('mint_verify_url')).status).toBe(400)
})

test('mark_email_destination_verified action updates the destination and logs audit events', async () => {
	const { env, post } = setupAdminUsers(
		[makeUser(2, 'member', { email_verified_at: '2026-01-01T00:00:00.000Z' })],
		[[2, 'user']],
	)
	const destinationId = 'dest-pager-1'
	await env.APP_DB.prepare(
		`INSERT INTO email_notification_destinations
		 (id, user_id, email, verified_at, is_default)
		 VALUES (?, 2, 'pager@example.com', NULL, 0)`,
	)
		.bind(destinationId)
		.run()

	const response = await post({
		action: 'mark_email_destination_verified',
		stableUserId: stableUserId(2),
		destinationEmail: 'pager@example.com',
	})
	expect(response.status).toBe(200)
	expectAdminAudit(
		'mark_email_destination_verified',
		`target_stable_user_id=${stableUserId(2)};destination=pager@example.com`,
	)
	const row = await env.APP_DB.prepare(
		`SELECT verified_at IS NOT NULL AS verified
		 FROM email_notification_destinations WHERE id = ?`,
	)
		.bind(destinationId)
		.first<{ verified: number }>()
	expect(row).toEqual({ verified: 1 })
})

test('create_user action returns setup link, logs audit, maps duplicate email to 409, and keeps the setup link when list refresh fails', async () => {
	const createdUser = {
		userId: 9,
		stableUserId: stableUserId(9),
		email: 'new-user@example.com',
		username: 'new-user',
		setupLink: 'https://example.com/reset-password?token=setup',
		setupTokenExpiresAt: 1_800_000_000_000,
	}
	const { env, post } = setupAdminUsers(
		[
			makeUser(9, 'new-user', {
				email_verified_at: '2026-09-10T00:00:00.000Z',
				plan: 'free',
			}),
		],
		[[9, 'user']],
	)
	const createBody = {
		action: 'create_user',
		email: 'new-user@example.com',
		username: 'new-user',
	}
	const createdUserPayload = {
		stableUserId: createdUser.stableUserId,
		email: createdUser.email,
		username: createdUser.username,
		setupLink: createdUser.setupLink,
		setupTokenExpiresAt: createdUser.setupTokenExpiresAt,
	}

	mockModule.adminCreateUserWithPasswordSetup.mockResolvedValueOnce(createdUser)
	const created = await post(createBody)
	expect(created.status).toBe(200)
	const createdPayload = (await Promise.resolve(
		created.data,
	)) as AdminUsersMutationData
	expect(createdPayload.createdUser).toEqual(createdUserPayload)
	expect(createdPayload).toEqual({ ok: true, createdUser: createdUserPayload })

	expect(mockModule.scheduleUserCreatedEvent).toHaveBeenCalledWith({
		env,
		user: {
			id: createdUser.stableUserId,
			username: createdUser.username,
			email: createdUser.email,
		},
		source: 'admin',
	})
	expectAdminAudit('create_user')

	mockModule.adminCreateUserWithPasswordSetup.mockRejectedValueOnce(
		new AdminUserCreation.AdminCreateUserError(
			'email_exists',
			'That email is already in use.',
		),
	)
	const duplicate = await post({
		action: 'create_user',
		email: 'new-user@example.com',
	})
	expect(duplicate.status).toBe(409)
	expect(await Promise.resolve(duplicate.data)).toEqual({
		ok: false,
		error: 'That email is already in use.',
		code: 'email_exists',
	})

	mockModule.adminCreateUserWithPasswordSetup.mockResolvedValueOnce(createdUser)
	const listRead = vi.fn(async () => {
		throw new Error('list refresh failed')
	})
	mockModule.loadAdminUsersData = listRead
	consoleWarn.mockImplementation(() => {})
	try {
		const refreshFailed = await post({
			action: 'create_user',
			email: 'refresh-fail@example.com',
			username: 'refresh-fail',
		})
		expect(refreshFailed.status).toBe(200)
		const refreshFailedPayload = (await Promise.resolve(
			refreshFailed.data,
		)) as AdminUsersMutationData
		expect(refreshFailedPayload.ok).toBe(true)
		expect(refreshFailedPayload).toEqual({
			ok: true,
			createdUser: createdUserPayload,
		})
		expect(listRead).not.toHaveBeenCalled()
	} finally {
		mockModule.loadAdminUsersData = undefined
	}
})
