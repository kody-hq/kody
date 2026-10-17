import { type AuthenticatedAppUser } from '#app/authenticated-user.ts'
import { createOrganization } from '#worker/orgs/create-organization.ts'
import { ensureOrgsTestSchema } from '#worker/orgs/orgs-test-schema.ts'
import { deriveRequestContext } from '#worker/request-context/request-context.ts'
import {
	createAuditTestDb,
	createTestOrgAuditWriter,
} from '#worker/test-support/create-audit-db.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { ensureUsersTestSchema } from '#worker/users-test-schema.ts'
import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { DatabaseSync } from 'node:sqlite'
import { beforeEach, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	readAuthenticatedAppUser: vi.fn(),
	authorize: vi.fn(),
}))

vi.mock('#app/authenticated-user.ts', () => ({
	readAuthenticatedAppUser: (...args: Array<unknown>) =>
		mocks.readAuthenticatedAppUser(...args),
}))

vi.mock('#worker/authorization/authorize.ts', async () => {
	const actual = await vi.importActual<
		typeof import('#worker/authorization/authorize.ts')
	>('#worker/authorization/authorize.ts')
	return {
		...actual,
		authorize: (...args: Array<unknown>) => mocks.authorize(...args),
	}
})

const { createWebsiteOrganization } = await import('./account-organizations.ts')

const personId = 'a'.repeat(64)
const now = '2026-01-01T00:00:00.000Z'

let db: D1Database

async function seed() {
	const sqlite = new DatabaseSync(':memory:')
	db = createD1FromSqlite(sqlite)
	await ensureOrgsTestSchema(db)
	await ensureUsersTestSchema({ db, columns: ['avatar_key'] })
	sqlite
		.prepare(
			`INSERT INTO users (id, username, email, password_hash, stable_user_id)
			 VALUES (9, 'ada', 'ada@example.com', 'x', ?)`,
		)
		.run(personId)
	await db
		.prepare(
			`INSERT INTO orgs (
				id, slug, display_name, plan, entitlement_ladder, created_at, updated_at
			) VALUES (?, 'ada', 'Ada', 'free', 'public', ?, ?)`,
		)
		.bind(personId, now, now)
		.run()
	await db
		.prepare(
			`INSERT INTO org_memberships (org_id, user_id, role, created_at)
			 VALUES (?, ?, 'owner', ?)`,
		)
		.bind(personId, personId, now)
		.run()
	await db
		.prepare(
			`INSERT INTO handles (handle, user_id, org_id, created_at)
			 VALUES ('ada', ?, NULL, ?)`,
		)
		.bind(personId, now)
		.run()
}

function signIn() {
	const user = {
		userId: 9,
		username: 'ada',
		email: 'ada@example.com',
		mcpUser: {
			userId: personIdFromStored(personId),
			username: 'ada',
			email: 'ada@example.com',
			displayName: 'Ada',
		},
		request: deriveRequestContext({
			user: {
				userId: personIdFromStored(personId),
				username: 'ada',
			},
			source: { kind: 'session' },
			orgBinding: {
				org: { id: ownerIdFromStored(personId), slug: 'ada' },
				role: 'owner',
			},
		}),
	} as AuthenticatedAppUser
	mocks.readAuthenticatedAppUser.mockResolvedValue(user)
	return user
}

beforeEach(async () => {
	mocks.readAuthenticatedAppUser.mockReset()
	mocks.authorize.mockReset()
	mocks.authorize.mockResolvedValue(undefined)
	await seed()
})

test('web create organization POST requires org:write like MCP orgCreate', async () => {
	const { AuthorizationError } =
		await import('#worker/authorization/authorize.ts')
	mocks.authorize.mockRejectedValue(
		new AuthorizationError({
			code: 'missing_permission',
			permission: 'org:write',
			orgId: ownerIdFromStored(personId),
			resource: null,
			message: 'Missing org:write',
		}),
	)
	signIn()
	const request = new Request('https://kody.test/account/organizations/new', {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			displayName: 'Zeta Co',
			slug: 'zeta-co',
		}),
	})
	const attempt = createFromRequest(
		{
			APP_DB: db,
			AUDIT_DB: createAuditTestDb(),
		} as Env,
		request,
	)
	await expect(attempt).rejects.toThrow(/permission/)
	expect(mocks.authorize).toHaveBeenCalledWith(
		expect.objectContaining({ env: expect.anything() }),
		'org:write',
	)
})

test('web create organization form rejects the reserved `me` handle in any case', async () => {
	signIn()
	for (const slug of ['me', 'ME']) {
		const request = new Request('https://kody.test/account/organizations/new', {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({ displayName: 'Me Co', slug }),
		})
		const attempt = createFromRequest(
			{
				APP_DB: db,
				AUDIT_DB: createAuditTestDb(),
				BUNDLE_ARTIFACTS_KV: undefined,
			} as unknown as Env,
			request,
		)
		await expect(attempt).rejects.toThrow('This username is reserved.')
	}
	expect(
		await db
			.prepare(`SELECT COUNT(*) AS count FROM orgs WHERE lower(slug) = 'me'`)
			.first<{ count: number }>(),
	).toEqual({ count: 0 })
})

test('web create organization form enforces the free-org ownership cap', async () => {
	signIn()
	const env = { APP_DB: db } as Pick<Env, 'BUNDLE_ARTIFACTS_KV'> & {
		APP_DB: D1Database
	}
	expect(
		await createOrganization(env.APP_DB, env, {
			personId,
			audit: createTestOrgAuditWriter(),
			slug: 'team-one',
			displayName: 'Team One',
		}),
	).toEqual({ ok: true, slug: 'team-one' })

	const request = new Request('https://kody.test/account/organizations/new', {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			displayName: 'Team Two',
			slug: 'team-two',
		}),
	})
	const attempt = createFromRequest(
		{
			APP_DB: db,
			AUDIT_DB: createAuditTestDb(),
			BUNDLE_ARTIFACTS_KV: undefined,
		} as unknown as Env,
		request,
	)
	await expect(attempt).rejects.toThrow(/2 free organizations/)
	expect(
		await db
			.prepare(`SELECT COUNT(*) AS count FROM orgs WHERE slug = ?`)
			.bind('team-two')
			.first<{ count: number }>(),
	).toEqual({ count: 0 })
})

async function createFromRequest(env: Env, request: Request) {
	const body = await request.formData()
	const user = await mocks.readAuthenticatedAppUser()
	return createWebsiteOrganization({
		env,
		user,
		displayName: String(body.get('displayName') ?? ''),
		slug: String(body.get('slug') ?? ''),
	})
}
