import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { utf8ToBase64Url } from '@kody-internal/shared/base64.ts'
import { beforeEach, expect, test } from 'vitest'
import {
	mintPackageAppTicketCookie,
	packageAppTicketTtlMs,
	readPackageAppTicket,
	resetPackageAppTicketKeysForTests,
	type PackageAppTicketGrant,
} from './package-app-ticket.ts'

const keyA = 'ticket-key-a-0123456789abcdef0123456789'
const keyB = 'ticket-key-b-0123456789abcdef0123456789'
const host = 'acme.kody.run'
const slug = 'Dashboard'
const now = 1_800_000_000_000
const session = { stableUserId: 'person-visitor', issuedAt: now - 5_000 }

const grant: PackageAppTicketGrant = {
	owner: {
		userId: ownerIdFromStored('org-acme'),
		username: 'acme',
		displayName: 'Acme',
		email: '',
	},
	visitor: {
		userId: personIdFromStored('person-visitor'),
		username: 'visitor',
		role: 'member',
	},
	epoch: 7,
}

function envWith(keys: string | undefined) {
	return {
		PACKAGE_APP_TICKET_KEYS: keys,
		COOKIE_SECRET: 'cookie-secret-0123456789abcdef0123456789',
	} as unknown as Env
}

async function mint(env: Env, overrides: { now?: number } = {}) {
	return await mintPackageAppTicketCookie({
		env,
		host,
		slug,
		sessionIssuedAt: session.issuedAt,
		grant,
		secure: true,
		now: overrides.now ?? now,
	})
}

function requestWith(setCookie: string) {
	const [pair] = setCookie.split(';')
	return new Request(`https://${host}/packages/dashboard/`, {
		headers: { Cookie: `other=1; ${pair}` },
	})
}

async function read(
	env: Env,
	request: Request,
	overrides: Partial<{
		host: string
		slug: string
		session: typeof session
		now: number
	}> = {},
) {
	return await readPackageAppTicket({
		request,
		env,
		host: overrides.host ?? host,
		slug: overrides.slug ?? slug,
		session: overrides.session ?? session,
		secure: true,
		now: overrides.now ?? now,
	})
}

beforeEach(() => {
	resetPackageAppTicketKeysForTests()
})

test('a minted ticket round-trips its grant and sets a short host-only cookie', async () => {
	const env = envWith(keyA)
	const cookie = await mint(env)

	expect(cookie).toMatch(/^__Host-kody_pkg_ticket_[\w-]{12}=/)
	expect(cookie).toContain('Path=/')
	expect(cookie).toContain(`Max-Age=${packageAppTicketTtlMs / 1000}`)
	expect(cookie).toContain('HttpOnly')
	expect(cookie).toContain('Secure')
	expect(cookie).not.toContain('Domain=')
	await expect(read(env, requestWith(cookie))).resolves.toEqual(grant)
})

test('rotation: every listed key verifies and the first key signs', async () => {
	const oldCookie = await mint(envWith(keyA))

	resetPackageAppTicketKeysForTests()
	const rotating = envWith(` ${keyB} , ${keyA} ,`)
	await expect(read(rotating, requestWith(oldCookie))).resolves.toEqual(grant)
	const newCookie = await mint(rotating)

	resetPackageAppTicketKeysForTests()
	const rotated = envWith(keyB)
	await expect(read(rotated, requestWith(newCookie))).resolves.toEqual(grant)
	await expect(read(rotated, requestWith(oldCookie))).resolves.toBeNull()
})

test('falls back to a COOKIE_SECRET-derived key when no ticket keys are set', async () => {
	const env = envWith(undefined)
	const cookie = await mint(env)
	await expect(read(env, requestWith(cookie))).resolves.toEqual(grant)

	resetPackageAppTicketKeysForTests()
	await expect(read(envWith(keyA), requestWith(cookie))).resolves.toBeNull()
})

test('a forged or tampered ticket is refused', async () => {
	const env = envWith(keyA)
	const cookie = await mint(env)
	const [pair] = cookie.split(';')
	const [name, value] = pair!.split('=')
	const [, signature] = value!.split('.')
	const forgedPayload = utf8ToBase64Url(
		JSON.stringify({
			v: 1,
			sub: 'person-visitor',
			sat: session.issuedAt,
			host,
			app: 'dashboard',
			exp: now + 60_000,
			ep: 7,
			role: 'owner',
			vu: 'visitor',
			oid: 'org-acme',
			ou: 'acme',
			od: 'Acme',
			oe: '',
		}),
	)
	const forged = new Request(`https://${host}/`, {
		headers: { Cookie: `${name}=${forgedPayload}.${signature}` },
	})
	await expect(read(env, forged)).resolves.toBeNull()

	const garbage = new Request(`https://${host}/`, {
		headers: { Cookie: `${name}=not-a-ticket` },
	})
	await expect(read(env, garbage)).resolves.toBeNull()
})

test('an expired ticket is refused', async () => {
	const env = envWith(keyA)
	const cookie = await mint(env)
	await expect(
		read(env, requestWith(cookie), { now: now + packageAppTicketTtlMs }),
	).resolves.toBeNull()
	await expect(
		read(env, requestWith(cookie), { now: now + packageAppTicketTtlMs - 1 }),
	).resolves.toEqual(grant)
})

test('a ticket is bound to its host, app, visitor, and session', async () => {
	const env = envWith(keyA)
	const request = requestWith(await mint(env))

	await expect(
		read(env, request, { host: 'evil.kody.run' }),
	).resolves.toBeNull()
	await expect(read(env, request, { slug: 'other-app' })).resolves.toBeNull()
	await expect(
		read(env, request, {
			session: { ...session, stableUserId: 'person-other' },
		}),
	).resolves.toBeNull()
	await expect(
		read(env, request, {
			session: { ...session, issuedAt: session.issuedAt + 1 },
		}),
	).resolves.toBeNull()
	await expect(read(env, request, { slug: 'dashboard' })).resolves.toEqual(
		grant,
	)
})
