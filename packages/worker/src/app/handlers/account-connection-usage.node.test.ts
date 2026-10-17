import { type AuthenticatedAppUser } from '#app/authenticated-user.ts'
import { loadOrgBindingForSlug } from '#worker/orgs/repo.ts'
import { deriveRequestContext } from '#worker/request-context/request-context.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { ensureUsersTestSchema } from '#worker/users-test-schema.ts'
import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { type OrgRole } from '@kody-internal/shared/request-context.ts'
import { DatabaseSync } from 'node:sqlite'
import { beforeEach, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	readAuthenticatedAppUser: vi.fn(),
	loadConnectionUsage: vi.fn(async (input: Record<string, unknown>) => ({
		ok: true,
		input,
	})),
}))

vi.mock('#app/authenticated-user.ts', () => ({
	readAuthenticatedAppUser: (...args: Array<unknown>) =>
		mocks.readAuthenticatedAppUser(...args),
}))
vi.mock('#worker/usage/connection-usage.ts', () => ({
	loadConnectionUsage: (input: Record<string, unknown>) =>
		mocks.loadConnectionUsage(input),
}))

const { loadAccountConnectionUsageData } =
	await import('./account-connection-usage.ts')

const now = '2026-10-07T00:00:00.000Z'

/**
 * Personal org per person, plus `acme`: Ada owns, Bob is a member, Cara is
 * billing, Dan is not in it.
 */
const people = {
	ada: { id: 9, personId: 'person-ada' },
	bob: { id: 10, personId: 'person-bob' },
	cara: { id: 11, personId: 'person-cara' },
	dan: { id: 12, personId: 'person-dan' },
} as const
type Person = keyof typeof people

let db: D1Database

beforeEach(async () => {
	vi.clearAllMocks()
	const sqlite = new DatabaseSync(':memory:')
	db = createD1FromSqlite(sqlite)
	await ensureUsersTestSchema({ db })
	for (const [username, person] of Object.entries(people)) {
		sqlite
			.prepare(
				`INSERT INTO users (id, username, email, password_hash, stable_user_id)
				 VALUES (?, ?, ?, 'x', ?)`,
			)
			.run(person.id, username, `${username}@example.com`, person.personId)
		sqlite
			.prepare(
				`INSERT INTO orgs (id, slug, display_name, created_at, updated_at)
				 VALUES (?, ?, NULL, ?, ?)`,
			)
			.run(person.personId, username, now, now)
		sqlite
			.prepare(
				`INSERT INTO org_memberships (org_id, user_id, role, created_at)
				 VALUES (?, ?, 'owner', ?)`,
			)
			.run(person.personId, person.personId, now)
	}
	sqlite
		.prepare(
			`INSERT INTO orgs (id, slug, display_name, created_at, updated_at)
			 VALUES ('org-acme', 'acme', 'Acme', ?, ?)`,
		)
		.run(now, now)
	for (const [person, role] of [
		['ada', 'owner'],
		['bob', 'member'],
		['cara', 'billing'],
	] as const) {
		sqlite
			.prepare(
				`INSERT INTO org_memberships (org_id, user_id, role, created_at)
				 VALUES ('org-acme', ?, ?, ?)`,
			)
			.run(people[person].personId, role, now)
	}
})

function createEnv() {
	return { APP_DB: db } as unknown as Env
}

/**
 * Mirrors `readAuthenticatedAppUser` after org binding: `team` binds `acme`
 * with the person's role there, otherwise the personal org.
 */
function signInAs(person: Person | null, team?: { role: OrgRole }) {
	mocks.readAuthenticatedAppUser.mockImplementation(async () => {
		if (!person) return null
		const { id, personId } = people[person]
		const mcpUser = {
			userId: personIdFromStored(personId),
			email: `${person}@example.com`,
			displayName: person,
		}
		return {
			sessionUserId: String(id),
			userId: id,
			username: person,
			email: mcpUser.email,
			emailVerified: true,
			emailVerificationDelivery: null,
			displayName: person,
			roles: ['user'],
			permissions: [],
			artifactOwnerIds: [String(id)],
			mcpUser,
			request: deriveRequestContext({
				user: mcpUser,
				source: { kind: 'session' },
				orgBinding: team
					? {
							org: { id: ownerIdFromStored('org-acme'), slug: 'acme' },
							role: team.role,
						}
					: {
							org: { id: ownerIdFromStored(personId), slug: person },
							role: 'owner',
						},
			}),
		} satisfies AuthenticatedAppUser
	})
}

async function getUsage(orgSlug?: string) {
	const user =
		(await mocks.readAuthenticatedAppUser()) as AuthenticatedAppUser | null
	if (!user) return { status: 401, error: 'Unauthorized.' }
	if (orgSlug) {
		const binding = await loadOrgBindingForSlug(
			db,
			user.mcpUser.userId,
			orgSlug,
		)
		if (!binding || binding.role == null)
			return { status: 404, error: 'Organization not found.' }
		user.request = deriveRequestContext({
			user: user.mcpUser,
			source: { kind: 'session' },
			orgBinding: binding,
		})
	}
	return {
		status: 200,
		data: await loadAccountConnectionUsageData({ env: createEnv(), user }),
	}
}

test('signed-out requests are rejected', async () => {
	signInAs(null)
	const response = await getUsage()
	expect(response.status).toBe(401)
	expect(mocks.loadConnectionUsage).not.toHaveBeenCalled()
})

test('personal org: the owner sees org-wide usage for their own org', async () => {
	signInAs('ada')
	const response = await getUsage()
	expect(response.status).toBe(200)
	expect(mocks.loadConnectionUsage).toHaveBeenCalledWith(
		expect.objectContaining({
			orgId: 'person-ada',
			orgSlug: 'ada',
			viewerPersonId: 'person-ada',
			includeOrgWide: true,
		}),
	)
})

test('team org: only owners and billing admins see teammates and Automation', async () => {
	for (const [person, role, includeOrgWide] of [
		['ada', 'owner', true],
		['bob', 'member', false],
		['cara', 'billing', true],
	] as const) {
		mocks.loadConnectionUsage.mockClear()
		signInAs(person, { role })
		const response = await getUsage()
		expect([person, response.status]).toEqual([person, 200])
		expect(mocks.loadConnectionUsage).toHaveBeenCalledWith(
			expect.objectContaining({
				orgId: 'org-acme',
				orgSlug: 'acme',
				viewerPersonId: people[person].personId,
				includeOrgWide,
			}),
		)
		const [call] = mocks.loadConnectionUsage.mock.calls.at(-1) ?? []
		const canSeePackage = call?.canSeePackage as (id: string) => boolean
		// Repositories rule: owners see every team package, members need a grant.
		expect([person, canSeePackage('pkg-team')]).toEqual([
			person,
			role === 'owner',
		])
	}
})

test('explicit org binding rejects non-members before reading usage', async () => {
	expect(
		await loadOrgBindingForSlug(db, personIdFromStored('person-bob'), 'acme'),
	).toMatchObject({ org: { slug: 'acme' }, role: 'member' })
	signInAs('dan')
	expect(await getUsage('acme')).toEqual({
		status: 404,
		error: 'Organization not found.',
	})
	expect(mocks.loadConnectionUsage).not.toHaveBeenCalled()
})
