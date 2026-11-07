import {
	mintPersonId,
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { applyD1Migrations, type D1Migration } from 'cloudflare:test'
import { env, exports } from 'cloudflare:workers'
import { http, HttpResponse } from 'msw'
import { beforeAll, expect, test } from 'vitest'
import { createPackageAppSessionCookie } from '#app/package-app-session.ts'
import { saveSecret } from '#mcp/secrets/service.ts'
import { ensurePersonalOrg } from '#worker/orgs/provision.ts'
import {
	forgetPackageAppRunsAs,
	recordPackageAppPublisher,
} from '#worker/package-runtime/package-app-authority.ts'
import { insertPackageCapabilityApproval } from '#worker/package-capabilities/capability-approvals-repo.ts'
import { createMswWorkerServer } from '#worker/test-support/msw-worker-server.ts'
import { setupServedPackageApp } from '#worker/test-support/served-package-app.ts'

/**
 * A signed-in person outside the publishing team org opens an approved
 * internet-visible app through the real package-app origin. The app's
 * publisher-supplied credential reaches a stub upstream through the fetch
 * gateway; the visitor never sees the value and gains no membership or role.
 */

const testEnv = env as Env & {
	TEST_MIGRATIONS: Array<D1Migration>
	TEST_AUDIT_MIGRATIONS: Array<D1Migration>
}

beforeAll(async () => {
	await applyD1Migrations(testEnv.APP_DB, testEnv.TEST_MIGRATIONS)
	await applyD1Migrations(testEnv.AUDIT_DB, testEnv.TEST_AUDIT_MIGRATIONS)
	await env.APP_DB.prepare(
		`INSERT INTO feature_flags (key, enabled, note, audience, updated_at)
		 VALUES ('package-credential-suppliers', 1, '', 'everyone', CURRENT_TIMESTAMP)
		 ON CONFLICT(key) DO UPDATE SET enabled = 1, audience = 'everyone'`,
	).run()
	const mutableEnv = env as unknown as Record<string, string | undefined>
	mutableEnv.APP_BASE_URL = 'https://app.kody.test:8788'
	mutableEnv.PACKAGE_APP_BASE_URL = 'https://packages.isolated.test'
	mutableEnv.SENTRY_ENVIRONMENT = 'production'
})

const stubHost = 'publisher-stub.example.test'
const publisherSecret = 'synthetic-publisher-token-value'
const visitorSecret = 'synthetic-visitor-token-value'

const appSource = `import { credential } from 'kody:runtime'
export default {
	async fetch() {
		const msg = (e) => String(e?.body?.code ?? e?.code ?? '') + ' ' + String(e?.message ?? e).slice(0, 300)
		const out = {}
		try {
			const shared = await credential('shared')
			out.handle = { name: shared.name, scope: shared.scope, keys: Object.keys(shared).sort() }
			const res = await shared.fetch('https://${stubHost}/check')
			out.status = res.status
			out.upstream = await res.json()
		} catch (e) { out.error = msg(e) }
		try {
			await credential.visitor('shared')
			out.visitorOpened = true
		} catch (e) { out.visitorError = msg(e) }
		return Response.json(out)
	},
}`

const publisherNeed = {
	shared: {
		description: 'Shared stub credential.',
		provider: 'publisher-stub',
		supplier: 'publisher',
	},
}

async function storeStubCredential(input: {
	ownerId: string
	name: string
	value: string
}) {
	await saveSecret({
		env,
		userId: input.ownerId,
		scope: 'user',
		name: input.name,
		value: input.value,
		audit: null,
	} as never)
	await env.APP_DB.prepare(
		`UPDATE secret_entries
		 SET kind = 'secret', provider = 'publisher-stub', allowed_hosts = ?, inject_json = ?
		 WHERE name = ?`,
	)
		.bind(
			JSON.stringify([stubHost]),
			JSON.stringify({
				kind: 'header',
				name: 'Authorization',
				format: 'Bearer {value}',
			}),
			input.name,
		)
		.run()
}

async function setup(input: {
	credentials: Record<string, unknown>
	approved?: boolean
	publisherCredential?: boolean
	visitorCredential?: boolean
}) {
	const t = await setupServedPackageApp({
		appSource,
		teamOrg: true,
		credentials: input.credentials,
	})
	const scope = {
		orgId: ownerIdFromStored(t.appOwnerId),
		packageId: t.packageId,
	}
	await recordPackageAppPublisher({
		db: env.APP_DB,
		scope,
		personId: personIdFromStored(t.ownerId),
		publisherIsOwner: true,
	})
	forgetPackageAppRunsAs(scope)
	if (input.approved !== false) {
		const now = new Date().toISOString()
		await insertPackageCapabilityApproval(env.APP_DB, {
			id: `approval-${t.packageId}`,
			package_id: t.packageId,
			owner_user_id: t.appOwnerId,
			published_commit: t.savedPackage.publishedCommit,
			fingerprint: `fingerprint-${t.packageId}`,
			capability_set_json: '[]',
			dependency_snapshot_json: '{}',
			approved_by_user_id: t.ownerId,
			approved_at: now,
		})
	}
	if (input.publisherCredential !== false) {
		await storeStubCredential({
			ownerId: t.appOwnerId,
			name: `publisher-stub-${t.packageId}`,
			value: publisherSecret,
		})
	}
	const outsiderId = mintPersonId() as string
	const outsiderName = `out-${outsiderId.slice(-10)}`
	await env.APP_DB.prepare(
		`INSERT INTO users (username, email, password_hash, stable_user_id)
		 VALUES (?, ?, 'hash', ?)`,
	)
		.bind(outsiderName, `${outsiderName}@example.com`, outsiderId)
		.run()
	await ensurePersonalOrg(env.APP_DB, {
		stableUserId: outsiderId,
		username: outsiderName,
	})
	if (input.visitorCredential) {
		await storeStubCredential({
			ownerId: outsiderId,
			name: `visitor-stub-${t.packageId}`,
			value: visitorSecret,
		})
	}
	const [sessionCookie] = await createPackageAppSessionCookie({
		env,
		session: { stableUserId: outsiderId, username: t.appSlug },
		slug: t.savedPackage.kodyId,
		secure: true,
		expiresAt: Date.now() + 60 * 60 * 1000,
	})
	const cookie = sessionCookie?.split(';')[0] ?? ''
	const grantSignIn = async (scopes: string) => {
		await env.APP_DB.prepare(
			`INSERT INTO package_app_oauth_grants (
				id, person_id, org_username, kody_id, scopes, created_at
			) VALUES (?, ?, ?, ?, ?, ?)`,
		)
			.bind(
				`grant-${t.packageId}`,
				outsiderId,
				t.appSlug,
				t.savedPackage.kodyId,
				scopes,
				new Date().toISOString(),
			)
			.run()
	}
	const seen: Array<string | null> = []
	const open = async () => {
		using _server = createMswWorkerServer(
			[
				http.get(`https://${stubHost}/check`, ({ request }) => {
					const auth = request.headers.get('Authorization')
					seen.push(
						auth === `Bearer ${publisherSecret}`
							? 'publisher'
							: auth === `Bearer ${visitorSecret}`
								? 'visitor'
								: 'none',
					)
					return HttpResponse.json({
						authenticated: auth === `Bearer ${publisherSecret}`,
					})
				}),
			],
			{ onUnhandledFrame: 'bypass' } as never,
		)
		const response = await exports.default.fetch(
			new Request(
				`https://${t.appSlug}.packages.isolated.test/packages/${t.savedPackage.kodyId}`,
				{
					redirect: 'manual',
					headers: { Cookie: cookie, Accept: 'application/json' },
				},
			),
		)
		const text = await response.text()
		return { response, text }
	}
	const membershipRows = async () =>
		(
			await env.APP_DB.prepare(
				`SELECT org_id, role FROM org_memberships WHERE user_id = ?`,
			)
				.bind(outsiderId)
				.all()
		).results
	return { t, outsiderId, grantSignIn, open, seen, membershipRows }
}

const executorNeed = (required: boolean) => ({
	github: {
		description: 'Visitor stub credential.',
		provider: 'github',
		supplier: 'executor',
		required,
	},
})

function expectNoSecretIn(text: string) {
	expect(text).not.toContain(publisherSecret)
	expect(text).not.toContain(visitorSecret)
}

async function expectNoNewMembership(s: Awaited<ReturnType<typeof setup>>) {
	expect(await s.membershipRows()).toEqual([
		{ org_id: s.outsiderId, role: 'owner' },
	])
	const { results } = await env.APP_DB.prepare(
		`SELECT id FROM grants WHERE subject_id = ?`,
	)
		.bind(s.outsiderId)
		.all()
	expect(results).toEqual([])
}

test(
	'a signed-in outsider uses the approved app publisher credential through origin, runtime and gateway without seeing it or joining the org',
	{ timeout: 120_000 },
	async () => {
		const s = await setup({ credentials: publisherNeed })
		await s.grantSignIn('profile')
		const { response, text } = await s.open()
		expect(response.status).toBe(200)
		expect(JSON.parse(text)).toMatchObject({
			handle: {
				scope: 'org',
				keys: ['fetch', 'hosts', 'kind', 'name', 'scope', 'sign'],
			},
			status: 200,
			upstream: { authenticated: true },
		})
		expect(s.seen).toEqual(['publisher'])
		expectNoSecretIn(text)
		await expectNoNewMembership(s)
	},
)

test(
	'optional-only executor needs still send a signed-in outsider to consent once, then serve the publisher credential',
	{ timeout: 120_000 },
	async () => {
		const s = await setup({
			credentials: { ...publisherNeed, ...executorNeed(false) },
		})
		const first = await s.open()
		expect(first.response.status).toBe(302)
		const location = new URL(String(first.response.headers.get('Location')))
		expect(location.searchParams.get('prompt')).toBe('consent')
		expect(location.searchParams.get('scope')?.split(' ')).toEqual([
			'profile',
			'need:github',
		])
		expect(s.seen).toEqual([])
		// Consent that declines the optional need still serves the app.
		await s.grantSignIn('profile')
		const second = await s.open()
		expect(second.response.status).toBe(200)
		expect(JSON.parse(second.text)).toMatchObject({
			status: 200,
			upstream: { authenticated: true },
		})
		expect(s.seen).toEqual(['publisher'])
		expectNoSecretIn(second.text)
		await expectNoNewMembership(s)
	},
)

test(
	'a required executor need sends a signed-in outsider to consent before the publisher credential runs',
	{ timeout: 120_000 },
	async () => {
		const s = await setup({
			credentials: { ...publisherNeed, ...executorNeed(true) },
		})
		await s.grantSignIn('profile')
		const { response } = await s.open()
		expect(response.status).toBe(302)
		const location = new URL(String(response.headers.get('Location')))
		expect(location.searchParams.get('scope')?.split(' ')).toEqual([
			'profile',
			'need:github',
		])
		expect(s.seen).toEqual([])
		await expectNoNewMembership(s)
	},
)

test(
	'an app without owner approval never runs the publisher credential for a signed-in outsider',
	{ timeout: 120_000 },
	async () => {
		const s = await setup({ credentials: publisherNeed, approved: false })
		await s.grantSignIn('profile')
		const { response, text } = await s.open()
		expect(response.status).not.toBe(200)
		expect(s.seen).toEqual([])
		expectNoSecretIn(text)
		await expectNoNewMembership(s)
	},
)

test(
	'a publisher need with no publisher credential fails closed instead of using the visitor own credential',
	{ timeout: 120_000 },
	async () => {
		const s = await setup({
			credentials: publisherNeed,
			publisherCredential: false,
			visitorCredential: true,
		})
		await s.grantSignIn('profile')
		const { response, text } = await s.open()
		expect(response.status).toBe(200)
		const body = JSON.parse(text)
		expect(body.handle).toBeUndefined()
		expect(body.error).toMatch(/^credential_unbound /)
		expect(s.seen).toEqual([])
		expectNoSecretIn(text)
	},
)

test(
	'with both a publisher and a visitor credential the publisher one is placed and credential.visitor is refused',
	{ timeout: 120_000 },
	async () => {
		const s = await setup({
			credentials: publisherNeed,
			visitorCredential: true,
		})
		await s.grantSignIn('profile')
		const { response, text } = await s.open()
		expect(response.status).toBe(200)
		const body = JSON.parse(text)
		expect(body.upstream).toEqual({ authenticated: true })
		expect(body.visitorOpened).toBeUndefined()
		expect(body.visitorError).toMatch(
			/Credential need "shared" is supplied by the publisher; use credential\("shared"\)/,
		)
		expect(s.seen).toEqual(['publisher'])
		expectNoSecretIn(text)
		await expectNoNewMembership(s)
	},
)
