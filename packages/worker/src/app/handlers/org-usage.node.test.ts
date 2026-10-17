import { DatabaseSync } from 'node:sqlite'
import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { beforeEach, expect, test, vi } from 'vitest'
import { type AuthenticatedAppUser } from '#app/authenticated-user.ts'
import { loadRequestOrgResolution } from '#app/org-request-binding.ts'
import type * as CreditTopUps from '#worker/billing/credit-top-ups.ts'
import { CreditTopUpError } from '#worker/billing/credit-top-ups.ts'
import { deriveRequestContext } from '#worker/request-context/request-context.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { consoleError } from '#worker/test-support/console-spies.ts'
import { ensureUsersTestSchema } from '#worker/users-test-schema.ts'

const mocks = vi.hoisted(() => ({
	readAuthenticatedAppUser: vi.fn(),
	requireAuthenticatedPageUser: vi.fn(),
	loadAccountUsageData: vi.fn(async (input: Record<string, unknown>) => ({
		ok: true,
		org: input.org,
	})),
	applyCreditTopUpFromCheckoutSession:
		vi.fn<(input: unknown) => Promise<unknown>>(),
}))

vi.mock('#app/authenticated-user.ts', () => ({
	readAuthenticatedAppUser: (...args: Array<unknown>) =>
		mocks.readAuthenticatedAppUser(...args),
}))
vi.mock('#app/page-auth.ts', () => ({
	requireAuthenticatedPageUser: (...args: Array<unknown>) =>
		mocks.requireAuthenticatedPageUser(...args),
}))
vi.mock('#app/account-usage-data.ts', () => ({
	loadAccountUsageData: (input: Record<string, unknown>) =>
		mocks.loadAccountUsageData(input),
}))
vi.mock('#worker/billing/credit-top-ups.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof CreditTopUps>()
	return {
		...actual,
		applyCreditTopUpFromCheckoutSession: (input: unknown) =>
			mocks.applyCreditTopUpFromCheckoutSession(input),
	}
})

const { loadOrgUsagePageResult, completeOrgCreditTopUp } =
	await import('./org-usage.ts')

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

function createEnv(overrides: Record<string, unknown> = {}) {
	return {
		COOKIE_SECRET: 'test-cookie-secret-0123456789abcdef0123456789',
		STRIPE_SECRET_KEY: 'sk_test_secret',
		APP_DB: db,
		...overrides,
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
	mocks.requireAuthenticatedPageUser.mockImplementation(
		async (request: Request, env: Env) =>
			(await sign(request, env)) ??
			Response.redirect('https://example.com/login', 302),
	)
}

async function call(
	env: Env,
	path: string,
	init?: RequestInit,
	completion = false,
) {
	const request = new Request(`https://example.com${path}`, init)
	const user = await mocks.requireAuthenticatedPageUser(request, env)
	if (user instanceof Response)
		return {
			status: user.status,
			headers: user.headers,
			data: null,
			error: await user.text(),
		}
	const url = new URL(request.url)
	const result = completion
		? await completeOrgCreditTopUp({
				env,
				user,
				orgSlug: url.pathname.split('/')[1]!.slice(1),
				sessionId: url.searchParams.get('session_id') ?? '',
			})
		: await loadOrgUsagePageResult({
				env,
				user,
				orgSlug: url.pathname.split('/')[1]!.slice(1),
				credits: url.searchParams.get('credits'),
				error: url.searchParams.get('error'),
				topup: url.searchParams.get('topup'),
				sessionId: url.searchParams.get('session_id'),
			})
	if (result.kind === 'redirect')
		return {
			status: 302,
			headers: new Headers({
				Location: new URL(result.href, request.url).toString(),
			}),
			data: null,
			error: '',
		}
	if (result.kind === 'denied')
		return {
			status: result.status,
			headers: new Headers(),
			data: null,
			error: result.error,
		}
	return {
		status: 200,
		headers: new Headers(),
		data: result.payload,
		error: null,
	}
}

beforeEach(async () => {
	vi.clearAllMocks()
	mocks.loadAccountUsageData.mockImplementation(
		async (input: Record<string, unknown>) => ({
			ok: true,
			org: input.org,
		}),
	)
	await seed()
	signInAs('ada')
})

test('usage data is readable by owners and billing admins of the org in the URL', async () => {
	const env = createEnv()
	const getUsage = (slug: string) => call(env, `/@${slug}/-/usage`)

	signInAs('cara')
	const billingAdmin = await getUsage('acme')
	expect(billingAdmin.status).toBe(200)
	expect(billingAdmin.data).toEqual({
		ok: true,
		org: {
			id: 'org-acme',
			slug: 'acme',
			displayName: 'Acme',
			personal: false,
		},
	})
	expect(mocks.loadAccountUsageData).toHaveBeenCalledWith(
		expect.objectContaining({
			org: {
				id: 'org-acme',
				slug: 'acme',
				displayName: 'Acme',
				personal: false,
			},
		}),
	)

	signInAs('ada')
	expect((await getUsage('ada')).data).toMatchObject({
		org: { id: 'person-ada', slug: 'ada', personal: true },
	})

	signInAs('bob')
	expect((await getUsage('acme')).status).toBe(403)
	signInAs('dan')
	expect((await getUsage('acme')).status).toBe(404)
	signInAs(null)
	expect((await getUsage('acme')).status).toBe(302)
})

test('the usage page mirrors the API access matrix', async () => {
	const env = createEnv()
	const getPage = (slug: string) => call(env, `/@${slug}/-/usage`)

	signInAs('ada')
	const owner = await getPage('acme')
	expect(owner.status).toBe(200)
	expect(owner.data).toMatchObject({
		ok: true,
		org: { id: 'org-acme', slug: 'acme', personal: false },
	})

	signInAs('cara')
	expect((await getPage('acme')).status).toBe(200)

	signInAs('bob')
	const member = await getPage('acme')
	expect(member.status).toBe(403)
	expect(member.error).toContain('Only owners and billing admins')

	signInAs('dan')
	const outsider = await getPage('acme')
	expect(outsider.status).toBe(404)
	expect(outsider.error).toContain('Organization unavailable')
})

const complete = (env: Env, path: string) => call(env, path, undefined, true)

test('usage reads never apply a checkout even when legacy return parameters are present', async () => {
	const env = createEnv()
	signInAs('ada')
	const response = await call(
		env,
		'/@ada/-/usage?topup=success&session_id=cs_123',
	)
	expect(response.status).toBe(200)
	expect(mocks.applyCreditTopUpFromCheckoutSession).not.toHaveBeenCalled()
})

test('a confirmed Stripe return lands on the Credits section with the added notice', async () => {
	const env = createEnv()
	signInAs('ada')
	const response = await complete(
		env,
		'/@ada/-/usage?topup=success&session_id=cs_123',
	)
	expect(mocks.applyCreditTopUpFromCheckoutSession).toHaveBeenCalledWith(
		expect.objectContaining({
			sessionId: 'cs_123',
			expectedStableUserId: ownerIdFromStored('person-ada'),
		}),
	)
	expect(response.status).toBe(302)
	expect(response.headers.get('Location')).toBe(
		'https://example.com/@ada/-/usage?credits=added#credits',
	)
})

test('a rejected Stripe return keeps known codes and folds the rest into topup_failed', async () => {
	consoleError.mockImplementation(() => {})
	const env = createEnv()
	signInAs('ada')

	mocks.applyCreditTopUpFromCheckoutSession.mockRejectedValueOnce(
		new CreditTopUpError('not_paid', 'Not paid.'),
	)
	const notPaid = await complete(
		env,
		'/@ada/-/usage?topup=success&session_id=cs_1',
	)
	expect(notPaid.headers.get('Location')).toBe(
		'https://example.com/@ada/-/usage?error=not_paid#credits',
	)

	mocks.applyCreditTopUpFromCheckoutSession.mockRejectedValueOnce(
		new CreditTopUpError('user_not_found', 'Missing.'),
	)
	const unknown = await complete(
		env,
		'/@ada/-/usage?topup=success&session_id=cs_2',
	)
	expect(unknown.headers.get('Location')).toBe(
		'https://example.com/@ada/-/usage?error=topup_failed#credits',
	)
	expect(consoleError.mock.calls.map(([message]) => message)).toEqual([
		'credit_top_up_confirm_failed',
		'credit_top_up_confirm_failed',
	])
})

test('notice and error codes map to messages; unknown and prototype keys map to nothing', async () => {
	const env = createEnv()
	signInAs('ada')
	await call(env, '/@ada/-/usage?credits=added&error=not_paid')
	expect(mocks.loadAccountUsageData).toHaveBeenLastCalledWith(
		expect.objectContaining({
			notice: expect.any(String),
			error: expect.any(String),
		}),
	)

	await call(env, '/@ada/-/usage?credits=__proto__&error=constructor')
	expect(mocks.loadAccountUsageData).toHaveBeenLastCalledWith(
		expect.objectContaining({ notice: undefined, error: undefined }),
	)
	expect(mocks.applyCreditTopUpFromCheckoutSession).not.toHaveBeenCalled()
})

test('typed usage selection cannot authorize one org while reading another', async () => {
	const env = createEnv()
	const user = await mocks.requireAuthenticatedPageUser(
		new Request('https://example.com/@ada/-/usage'),
		env,
	)
	if (user instanceof Response) throw new Error('Expected authenticated actor')
	const result = await loadOrgUsagePageResult({
		env,
		user,
		orgSlug: 'acme',
		credits: null,
		error: null,
		topup: null,
		sessionId: null,
	})
	expect(result).toEqual({
		kind: 'denied',
		status: 404,
		error: 'Organization unavailable.',
	})
	expect(mocks.loadAccountUsageData).not.toHaveBeenCalled()
	expect(mocks.applyCreditTopUpFromCheckoutSession).not.toHaveBeenCalled()
})
