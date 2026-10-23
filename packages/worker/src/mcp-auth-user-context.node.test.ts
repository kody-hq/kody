import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { consoleError } from '#worker/test-support/console-spies.ts'

const mockModule = vi.hoisted(() => ({
	getUserRolesAndPermissions: vi.fn(),
}))

vi.mock('#worker/identity/permissions-db.ts', () => ({
	getUserRolesAndPermissions: (...args: Array<unknown>) =>
		mockModule.getUserRolesAndPermissions(...args),
}))

const {
	buildMcpUserContextFromGrantProps,
	buildMcpUserContextWithOrgBindingFromGrantProps,
} = await import('./mcp-auth-user-context.ts')

type GrantUserRow = {
	id: number
	email: string
	username: string | null
	display_name: string | null
	stable_user_id: string
	personal_org_id?: string | null
	deleting_at?: string | null
	email_verified_at?: string | null
	suspended_at?: string | null
	password_changed_at?: string | null
}

function createMockAppDb(options: {
	row?: GrantUserRow | null
	reject?: Error
}) {
	const queries: Array<{ sql: string; params: Array<unknown> }> = []
	const db = {
		prepare(sql: string) {
			return {
				bind(...params: Array<unknown>) {
					queries.push({ sql, params })
					return {
						async first<T>() {
							if (options.reject) throw options.reject
							const normalized = sql.replace(/\s+/g, ' ').toLowerCase()
							if (
								normalized.includes('where stable_user_id = ?') &&
								normalized.includes('select id')
							) {
								return (options.row ?? null) as T | null
							}
							throw new Error(`Unsupported query: ${sql}`)
						},
					}
				},
			}
		},
	} as unknown as D1Database
	return { db, queries }
}

function account(
	id: number,
	stableUserId: string,
	email: string,
	username: string,
	extra: Partial<GrantUserRow> = {},
): GrantUserRow {
	return {
		id,
		email,
		username,
		display_name: null,
		stable_user_id: stableUserId,
		...extra,
	}
}

type GrantProps = NonNullable<
	Parameters<typeof buildMcpUserContextFromGrantProps>[1]
>

async function build(
	options: Parameters<typeof createMockAppDb>[0],
	grantProps: GrantProps,
) {
	const appDb = createMockAppDb(options)
	const result = await buildMcpUserContextFromGrantProps(
		{ APP_DB: appDb.db } as Env,
		grantProps,
	)
	return { result, ...appDb }
}

test('buildMcpUserContextFromGrantProps resolves identity from the stable user id', async () => {
	const resolvedCases: Array<{
		grantProps: GrantProps
		row: GrantUserRow
		roles: Array<string>
		permissions: Array<string>
		email: string
		username: string
		displayName: string
	}> = [
		{
			grantProps: {
				userId: ownerIdFromStored('stable-admin-id'),
				email: 'stale@example.com',
				displayName: 'stale',
			},
			row: account(42, 'stable-admin-id', 'current@example.com', 'admin', {
				display_name: 'Admin Display',
			}),
			roles: ['admin'],
			permissions: ['read:user:any', 'read:role:any'],
			email: 'current@example.com',
			username: 'admin',
			displayName: 'Admin Display',
		},
		{
			grantProps: {
				userId: ownerIdFromStored('stable-original'),
				email: 'reused-by-admin@example.com',
				displayName: 'stale',
			},
			row: account(
				7,
				'stable-original',
				'original-owner@example.com',
				'original',
			),
			roles: ['user'],
			permissions: [],
			email: 'original-owner@example.com',
			username: 'original',
			displayName: 'original',
		},
		{
			grantProps: { userId: ownerIdFromStored('legacy-id') },
			row: account(9, 'legacy-id', 'resolved@example.com', 'resolved'),
			roles: ['user'],
			permissions: [],
			email: 'resolved@example.com',
			username: 'resolved',
			displayName: 'resolved',
		},
	]
	for (const {
		grantProps,
		row,
		roles,
		permissions,
		...user
	} of resolvedCases) {
		mockModule.getUserRolesAndPermissions.mockResolvedValueOnce({
			roles,
			permissions,
		})
		const { result, db, queries } = await build({ row }, grantProps)
		expect(result).toEqual({
			user: {
				userId: grantProps.userId,
				personalOrgId: ownerIdFromStored(row.stable_user_id),
				...user,
				roles,
				permissions,
			},
			emailVerified: false,
			suspended: false,
			passwordChangedAt: null,
		})
		expect(queries.map((query) => query.params)).toEqual([[grantProps.userId]])
		for (const column of [
			'personal_org_id',
			'email_verified_at',
			'suspended_at',
			'password_changed_at',
		]) {
			expect(queries[0]?.sql).toContain(column)
		}
		expect(mockModule.getUserRolesAndPermissions).toHaveBeenLastCalledWith(
			db,
			row.id,
		)
	}

	const missingRow = await build(
		{ row: null },
		{
			userId: ownerIdFromStored('orphan-id'),
			email: 'missing@example.com',
			displayName: 'missing',
		},
	)
	expect(missingRow.result).toBeNull()
	const deleting = await build(
		{
			row: account(10, 'deleting-id', 'deleting@example.com', 'deleting', {
				deleting_at: '2026-07-22 22:00:00',
			}),
		},
		{ userId: ownerIdFromStored('deleting-id'), email: 'deleting@example.com' },
	)
	expect(deleting.result).toBeNull()

	consoleError.mockImplementation(() => {})
	await expect(
		build(
			{ reject: new Error('D1 unavailable') },
			{
				userId: ownerIdFromStored('resilient-id'),
				email: 'resilient@example.com',
				displayName: 'resilient',
			},
		),
	).rejects.toThrow('D1 unavailable')
	expect(consoleError).toHaveBeenCalled()
	expect(mockModule.getUserRolesAndPermissions).toHaveBeenCalledTimes(
		resolvedCases.length,
	)
})

test('MCP auth reads verification and suspension from the account row', async () => {
	mockModule.getUserRolesAndPermissions.mockResolvedValue({
		roles: ['user'],
		permissions: [],
	})
	const verifiedAt = { email_verified_at: '2026-07-22 22:00:00' }
	const results = await Promise.all(
		[
			account(
				11,
				'verified-id',
				'verified@example.com',
				'verified',
				verifiedAt,
			),
			account(12, 'suspended-id', 'suspended@example.com', 'suspended', {
				...verifiedAt,
				suspended_at: '2026-07-23 22:00:00',
			}),
		].map(async (row) => {
			const { result } = await build({ row }, { userId: row.stable_user_id })
			return {
				emailVerified: result?.emailVerified,
				suspended: result?.suspended,
			}
		}),
	)
	expect(results).toEqual([
		{ emailVerified: true, suspended: false },
		{ emailVerified: true, suspended: true },
	])
})

test('buildMcpUserContextWithOrgBindingFromGrantProps reads the user row and org binding in one D1 batch', async () => {
	mockModule.getUserRolesAndPermissions.mockResolvedValue({
		roles: ['user'],
		permissions: [],
	})
	const row = account(9, 'stable-member', 'member@example.com', 'member', {
		email_verified_at: '2026-01-01T00:00:00.000Z',
	})
	const batches: Array<Array<string>> = []
	function createBatchDb(options: {
		membershipRow: unknown
		grantRow: unknown
	}) {
		return {
			prepare(sql: string) {
				return {
					bind() {
						return { sql }
					},
				}
			},
			async batch(statements: Array<{ sql: string }>) {
				batches.push(statements.map((statement) => statement.sql))
				return statements.map(({ sql }) => {
					const normalized = sql.replace(/\s+/g, ' ').toLowerCase()
					let result: unknown = null
					if (normalized.includes('from users')) result = row
					else if (
						normalized.includes('from org_memberships') ||
						normalized.includes('join org_memberships')
					) {
						result = options.membershipRow
					} else if (normalized.includes('exists (')) {
						result = options.grantRow
					}
					return { results: result == null ? [] : [result], meta: {} }
				})
			},
		} as unknown as D1Database
	}
	const grantProps = {
		userId: ownerIdFromStored('stable-member'),
		metadata: { orgId: ownerIdFromStored('org-team') },
	} as GrantProps

	const bound = await buildMcpUserContextWithOrgBindingFromGrantProps(
		{
			APP_DB: createBatchDb({
				membershipRow: { org_id: 'org-team', org_slug: 'team', role: 'member' },
				grantRow: null,
			}),
		} as Env,
		grantProps,
	)
	expect(bound?.context.user.email).toBe('member@example.com')
	expect(bound?.context.emailVerified).toBe(true)
	expect(bound?.orgBinding).toEqual({
		org: { id: ownerIdFromStored('org-team'), slug: 'team' },
		role: 'member',
	})
	expect(batches).toHaveLength(1)
	expect(batches[0]).toHaveLength(3)
	expect(batches[0]?.[0]).toContain('FROM users')
	expect(batches[0]?.[1]).toContain('FROM org_memberships')

	// Membership gone in the same snapshot: no role is granted.
	const unbound = await buildMcpUserContextWithOrgBindingFromGrantProps(
		{ APP_DB: createBatchDb({ membershipRow: null, grantRow: null }) } as Env,
		grantProps,
	)
	expect(unbound?.context.user.email).toBe('member@example.com')
	expect(unbound?.orgBinding).toBeNull()

	// A live grant without membership binds as an outside collaborator.
	const collaborator = await buildMcpUserContextWithOrgBindingFromGrantProps(
		{
			APP_DB: createBatchDb({
				membershipRow: null,
				grantRow: { org_id: 'org-team', org_slug: 'team' },
			}),
		} as Env,
		grantProps,
	)
	expect(collaborator?.orgBinding).toEqual({
		org: { id: ownerIdFromStored('org-team'), slug: 'team' },
		role: null,
	})
})
