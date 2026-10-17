import { DatabaseSync } from 'node:sqlite'
import { personIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { beforeEach, expect, test, vi } from 'vitest'
import type * as OrgCreditsData from '#app/org-credits-data.ts'
import { type AuthenticatedAppUser } from '#app/authenticated-user.ts'
import { loadRequestOrgResolution } from '#app/org-request-binding.ts'
import { deriveRequestContext } from '#worker/request-context/request-context.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { ensureUsersTestSchema } from '#worker/users-test-schema.ts'

const mocks = vi.hoisted(() => ({
	readAuthenticatedAppUser: vi.fn(),
	loadOrgCreditsData: vi.fn(async (input: Record<string, unknown>) => ({
		ok: true,
		input,
	})),
	env: {} as Env,
	request: new Request('https://example.com/_serverFn/credits'),
}))
vi.mock('#app/authenticated-user.ts', () => ({
	readAuthenticatedAppUser: (...args: unknown[]) =>
		mocks.readAuthenticatedAppUser(...args),
}))
vi.mock('#app/org-credits-data.ts', async (importOriginal) => ({
	...(await importOriginal<typeof OrgCreditsData>()),
	loadOrgCreditsData: (input: Record<string, unknown>) =>
		mocks.loadOrgCreditsData(input),
}))
vi.mock('@tanstack/react-start', () => ({
	getGlobalStartContext: () => ({ env: mocks.env }),
	createServerFn: () => {
		let validate = (v: unknown) => v
		const builder = {
			validator: (schema: { parse: (v: unknown) => unknown }) => {
				validate = schema.parse.bind(schema)
				return builder
			},
			handler:
				(fn: (v: { data: unknown }) => unknown) => (input: { data: unknown }) =>
					fn({ data: validate(input.data) }),
		}
		return builder
	},
}))
vi.mock('@tanstack/react-start/server', () => ({
	getRequest: () => mocks.request,
	setResponseHeader: vi.fn(),
}))
vi.mock('cloudflare:workers', async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	get env() {
		return mocks.env
	},
}))
vi.mock('#app/env.ts', () => ({ getEnv: () => mocks.env }))
vi.mock('../../../start/server/document-head.ts', () => ({
	loadDocumentHead: () => ({}),
}))
const { loadCreditsPage } = await import('../../../start/server/org-credits.ts')
const { encodeCreditLedgerCursor } = await import('#app/org-credits-data.ts')
const now = '2026-01-01T00:00:00.000Z'

/** Personal org per person, plus `acme` where Ada owns, Bob is a member, and Cara is billing. */
const people = {
	ada: { id: 9, personId: 'person-ada' },
	bob: { id: 10, personId: 'person-bob' },
	cara: { id: 11, personId: 'person-cara' },
	dan: { id: 12, personId: 'person-dan' },
} as const
type Person = keyof typeof people

let sqlite: DatabaseSync
let db: D1Database

async function seed() {
	sqlite = new DatabaseSync(':memory:')
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
}

function createEnv() {
	return {
		COOKIE_SECRET: 'test-cookie-secret-0123456789abcdef0123456789',
		APP_DB: db,
	} as unknown as Env
}

function signInAs(person: Person | null) {
	const sign = async (request: Request, env: Env) => {
		if (!person) return null
		const { id, personId } = people[person]
		const mcpUser = {
			userId: personIdFromStored(personId),
			email: `${person}@example.com`,
			displayName: person,
		}
		const resolution = await loadRequestOrgResolution(request, env, personId)
		const orgBinding =
			typeof resolution === 'string'
				? {
						org: { id: personId as never, slug: person },
						role: 'owner' as const,
					}
				: resolution
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
				orgBinding,
			}),
		} satisfies AuthenticatedAppUser
	}
	mocks.readAuthenticatedAppUser.mockImplementation(sign)
}

function call(orgSlug: string, cursor?: string) {
	mocks.env = createEnv()
	return loadCreditsPage({ data: { orgSlug, cursor } })
}

beforeEach(async () => {
	vi.clearAllMocks()
	await seed()
	signInAs('ada')
})

test('only owners and billing admins receive billing data; members receive their own budget', async () => {
	for (const [person, canReadBilling] of [
		['ada', true],
		['cara', true],
		['bob', false],
	] as const) {
		signInAs(person)
		await call('acme')
		expect(mocks.loadOrgCreditsData.mock.lastCall?.[0]).toMatchObject({
			org: { id: 'org-acme', slug: 'acme', personal: false },
			viewerUserId: people[person].personId,
			canReadBilling,
			before: null,
		})
	}
	signInAs('ada')
	await call('ada')
	expect(mocks.loadOrgCreditsData.mock.lastCall?.[0]).toMatchObject({
		org: { slug: 'ada', personal: true },
		canReadBilling: true,
	})
})
test('outsiders and anonymous users cannot read credits', async () => {
	signInAs('dan')
	await expect(call('acme')).rejects.toMatchObject({ isNotFound: true })
	signInAs('bob')
	await expect(call('ada')).rejects.toMatchObject({ isNotFound: true })
	signInAs(null)
	await expect(call('acme')).rejects.toMatchObject({
		options: { href: '/login?redirectTo=%2F%40acme%2F-%2Fcredits' },
	})
	expect(mocks.loadOrgCreditsData).not.toHaveBeenCalled()
})
test('ledger cursor is decoded and malformed input redirects before reading data', async () => {
	const cursor = encodeCreditLedgerCursor({
		createdAt: '2026-10-01T00:00:00.000Z',
		id: 'topup-1',
	})
	await call('acme', cursor)
	expect(mocks.loadOrgCreditsData).toHaveBeenLastCalledWith(
		expect.objectContaining({
			before: { createdAt: '2026-10-01T00:00:00.000Z', id: 'topup-1' },
		}),
	)
	mocks.loadOrgCreditsData.mockClear()
	await expect(call('acme', 'nope')).rejects.toMatchObject({
		options: { href: '/@acme/-/credits' },
	})
	expect(mocks.loadOrgCreditsData).not.toHaveBeenCalled()
})

test('grant-only collaborators see their own budget without billing access', async () => {
	sqlite
		.prepare(
			`INSERT INTO grants (id,org_id,resource_type,resource_id,subject_type,subject_id,preset,created_by_user_id,created_at,updated_at) VALUES ('credit-grant','org-acme','secret','secret-1','user',?,'use',?,?,?)`,
		)
		.run(people.dan.personId, people.ada.personId, now, now)
	signInAs('dan')
	await call('acme')
	expect(mocks.loadOrgCreditsData).toHaveBeenLastCalledWith(
		expect.objectContaining({
			org: expect.objectContaining({ id: 'org-acme' }),
			viewerUserId: people.dan.personId,
			canReadBilling: false,
		}),
	)
})

test('cursor redirects preserve unrelated search and login retains the requested cursor', async () => {
	mocks.env = createEnv()
	await expect(
		loadCreditsPage({
			data: { orgSlug: 'acme', cursor: 'nope', search: '?cursor=nope&x=1' },
		}),
	).rejects.toMatchObject({ options: { href: '/@acme/-/credits?x=1' } })
	expect(mocks.loadOrgCreditsData).not.toHaveBeenCalled()
	signInAs(null)
	await expect(
		loadCreditsPage({
			data: { orgSlug: 'acme', cursor: 'nope', search: '?cursor=nope&x=1' },
		}),
	).rejects.toMatchObject({
		options: {
			href:
				'/login?redirectTo=' +
				encodeURIComponent('/@acme/-/credits?cursor=nope&x=1'),
		},
	})
})
