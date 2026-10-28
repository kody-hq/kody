import { env, exports } from 'cloudflare:workers'
import { beforeEach, expect, test } from 'vitest'
import { setAuthSessionSecret } from '#app/auth-session.ts'
import { invalidatePackageAppOwnerCache } from '#app/package-app-owner.ts'
import { bumpAccessEpochStatement } from '#worker/authorization/access-compile.ts'
import {
	deleteSavedPackage,
	updateSavedPackage,
} from '#worker/package-registry/repo.ts'
import {
	silenceExpectedConsoleErrors,
	silenceExpectedConsoleWarns,
} from '#worker/test-support/console-spies.ts'
import {
	accessFixture,
	accessFixtureOrigin,
	packageAppAccessAuditRows,
	packageAppSessionCookieFor,
	seedPackageAppAccessFixture,
	type AccessFixturePerson,
} from '#worker/test-support/package-app-access-fixture.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'

/**
 * Access tickets on the package-app origin: revocation through the org
 * `access_epoch`, and failing closed when verification storage fails. The
 * fixture apps have no published source, so a request that clears the gate
 * ends in serve's host-setup 500; a denied visitor is redirected to the
 * package page.
 */

const mutableEnv = env as unknown as Record<string, unknown>

beforeEach(async () => {
	silenceExpectedConsoleErrors([
		'Package app handler failed:',
		'package-app-http-error',
	])
	mutableEnv.APP_BASE_URL = 'https://app.kody.test:8788'
	mutableEnv.PACKAGE_APP_BASE_URL = 'https://packages.isolated.test'
	mutableEnv.SENTRY_ENVIRONMENT = 'production'
	setAuthSessionSecret(env.COOKIE_SECRET)
	await seedPackageAppAccessFixture()
	sessions.clear()
	for (const person of Object.values(accessFixture.people)) {
		invalidatePackageAppOwnerCache({
			stableUserId: testStableUserIdFromEmail(person.email),
		})
	}
})

const sessions = new Map<AccessFixturePerson, string>()

async function visit(
	person: AccessFixturePerson,
	ticket?: string | null,
	path = `/packages/${accessFixture.privateApp.slug}`,
	websocket = false,
) {
	const session =
		sessions.get(person) ?? (await packageAppSessionCookieFor(person))
	sessions.set(person, session)
	const response = await exports.default.fetch(
		new Request(`${accessFixtureOrigin}${path}`, {
			redirect: 'manual',
			headers: {
				Cookie: [session, ticket].filter(Boolean).join('; '),
				...(websocket ? { Upgrade: 'websocket' } : {}),
			},
		}),
	)
	await response.arrayBuffer()
	const setCookie = response.headers.get('Set-Cookie') ?? ''
	return {
		status: response.status,
		location: response.headers.get('Location'),
		ticket:
			/(__Host-kody_pkg_ticket_[\w-]+=[^;]+)/.exec(setCookie)?.[1] ?? null,
	}
}

async function visitAnonymously(path: string) {
	const response = await exports.default.fetch(
		new Request(`${accessFixtureOrigin}${path}`, { redirect: 'manual' }),
	)
	return {
		status: response.status,
		location: response.headers.get('Location'),
		body: await response.text(),
	}
}

async function readEpoch() {
	const row = await env.APP_DB.prepare(
		`SELECT access_epoch FROM orgs WHERE id = ?`,
	)
		.bind(accessFixture.orgId)
		.first<{ access_epoch: number }>()
	return Number(row?.access_epoch ?? 0)
}

async function revokeMemberGrant() {
	await env.APP_DB.batch([
		env.APP_DB.prepare(
			`DELETE FROM grant_permissions WHERE grant_id = 'grant-cost-member'`,
		),
		env.APP_DB.prepare(`DELETE FROM grants WHERE id = 'grant-cost-member'`),
		bumpAccessEpochStatement(env.APP_DB, accessFixture.orgId),
	])
}

test('revoking access takes effect at the next ticket refresh and logs the deny', async () => {
	const first = await visit('member')
	expect(first).toMatchObject({ status: 500 })
	expect(first.ticket).not.toBeNull()

	await revokeMemberGrant()

	// The outstanding ticket is honored for the rest of its 90 s lifetime.
	const withTicket = await visit('member', first.ticket)
	expect(withTicket).toEqual({ status: 500, location: null, ticket: null })

	// Without it (expired), the refresh sees the new epoch and rechecks.
	const refreshed = await visit('member')
	expect(refreshed.status).toBe(302)
	expect(refreshed.ticket).toBeNull()
	expect(refreshed.location).toBe(
		`https://app.kody.test:8788/@${accessFixture.orgSlug}/${accessFixture.privateApp.slug}`,
	)

	const denies = await packageAppAccessAuditRows('package_app_access_denied')
	expect(denies).toEqual([
		{
			action: 'package_app_access_denied',
			result: 'failure',
			path: `/packages/${accessFixture.privateApp.slug}`,
			reason: `${accessFixture.orgSlug}/${accessFixture.privateApp.slug}: no app:execute`,
		},
	])
})

test('private app sign-in and execute gates cover pages, assets, and realtime', async () => {
	const anonymous = await visitAnonymously(
		`/packages/${accessFixture.privateApp.slug}`,
	)
	expect(anonymous.status).toBe(403)
	expect(anonymous.body).toContain('Open this package app from Kody')

	await revokeMemberGrant()
	const noAccessLocation = `https://app.kody.test:8788/@${accessFixture.orgSlug}/${accessFixture.privateApp.slug}`
	for (const [path, websocket] of [
		[`/packages/${accessFixture.privateApp.slug}`, false],
		[`/packages/${accessFixture.privateApp.slug}/_assets/app.js`, false],
		[`/packages/${accessFixture.privateApp.slug}/ws`, true],
	] as const) {
		expect(await visit('member', null, path, websocket)).toMatchObject({
			status: 302,
			location: noAccessLocation,
		})
	}
})

test('app visibility writes bump the org access epoch; projection refreshes do not', async () => {
	const before = await readEpoch()
	await updateSavedPackage(env.APP_DB, {
		userId: accessFixture.orgId,
		packageId: accessFixture.privateApp.id,
		description: 'refreshed on publish',
		audit: null,
	})
	expect(await readEpoch()).toBe(before)

	await updateSavedPackage(env.APP_DB, {
		userId: accessFixture.orgId,
		packageId: accessFixture.privateApp.id,
		hidden: false,
		audit: null,
	})
	expect(await readEpoch()).toBe(before + 1)

	// A stale visibility edit, or deleting a package that is already gone,
	// changes no row and keeps the epoch.
	const staleChanged = await updateSavedPackage(env.APP_DB, {
		userId: accessFixture.orgId,
		packageId: accessFixture.privateApp.id,
		hidden: true,
		expectedUpdatedAt: '2000-01-01T00:00:00.000Z',
		audit: null,
	})
	expect(staleChanged).toBe(false)
	const missingDeleted = await deleteSavedPackage(env.APP_DB, {
		userId: accessFixture.orgId,
		packageId: 'missing-package',
	})
	expect(missingDeleted).toBe(false)
	expect(await readEpoch()).toBe(before + 1)
})

test('a KV failure falls back to the full access check', async () => {
	silenceExpectedConsoleWarns([
		'package-app-access-decision-read-failed',
		'package-app-access-decision-write-failed',
	])
	const realKv = env.BUNDLE_ARTIFACTS_KV
	mutableEnv.BUNDLE_ARTIFACTS_KV = {
		get: async () => {
			throw new Error('KV unavailable')
		},
		put: async () => {
			throw new Error('KV unavailable')
		},
	}
	try {
		const allowed = await visit('collaborator')
		expect(allowed.status).toBe(500)
		expect(allowed.ticket).not.toBeNull()

		await revokeMemberGrant()
		const denied = await visit('member')
		expect(denied.status).toBe(302)
		expect(denied.ticket).toBeNull()
	} finally {
		mutableEnv.BUNDLE_ARTIFACTS_KV = realKv
	}
})

test('a D1 failure reading the access epoch fails closed', async () => {
	const realDb = env.APP_DB
	const failingDb = {
		prepare: (sql: string) => {
			if (sql.includes('SELECT access_epoch FROM orgs')) {
				throw new Error('D1 unavailable')
			}
			return realDb.prepare(sql)
		},
		batch: realDb.batch.bind(realDb),
		exec: realDb.exec.bind(realDb),
		withSession: realDb.withSession.bind(realDb),
		dump: realDb.dump.bind(realDb),
	} satisfies D1Database
	mutableEnv.APP_DB = failingDb
	try {
		// The error reaches the Workers runtime, which answers 500: nothing is
		// served and no ticket is minted.
		await expect(visit('owner')).rejects.toThrow('D1 unavailable')
	} finally {
		mutableEnv.APP_DB = realDb
	}
})
