import { DatabaseSync } from 'node:sqlite'
import { personalOrgId } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import type * as AuthenticatedUser from '#app/authenticated-user.ts'
import type * as DeploymentEnv from '#app/deployment-env.ts'
import type * as Authorize from '#worker/authorization/authorize.ts'
import type { UserLifecycleEvent } from '#worker/identity/user-lifecycle-subscription-event.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import {
	seedUser,
	testCookieSecret,
} from '#worker/test-support/auth-provider-harness.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	createGuestAccount,
	readGuestAccountByPerson,
} from './guest-accounts.ts'

const mocks = vi.hoisted(() => ({
	// Never settles: a slow or stuck dispatch must not hold up a claim.
	dispatch: vi.fn((_input: { event: unknown }) => new Promise<never>(() => {})),
	readAuthenticatedAppUser: vi.fn(),
	deleteUserAccount: vi.fn(async () => {}),
}))
vi.mock('#worker/identity/user-lifecycle-package-subscriptions.ts', () => ({
	dispatchUserLifecycleSubscriptionEvent: mocks.dispatch,
}))
vi.mock('#worker/email/transactional-send-policy.ts', () => ({
	sendGatedTransactionalEmail: async () => ({ ok: true as const }),
}))
vi.mock('#worker/billing/signup-welcome-credits.ts', () => ({
	maybeGrantSignupWelcomeCredits: async () => {},
}))
vi.mock('#app/deployment-env.ts', async (importOriginal) => ({
	...(await importOriginal<typeof DeploymentEnv>()),
	isNonProductionRuntime: () => true,
}))
vi.mock('#app/account-deletion.ts', () => ({
	deleteUserAccount: mocks.deleteUserAccount,
}))
vi.mock('#app/authenticated-user.ts', async (importOriginal) => ({
	...(await importOriginal<typeof AuthenticatedUser>()),
	readAuthenticatedAppUser: mocks.readAuthenticatedAppUser,
}))
// Org access checks are covered elsewhere; these tests only observe events.
vi.mock('#worker/authorization/authorize.ts', async (importOriginal) => ({
	...(await importOriginal<typeof Authorize>()),
	authorizeSurface: async () => {},
}))
vi.mock('#worker/org-transfer/apply.ts', () => ({
	runOrgResourceTransfer: async () => ({
		outcome: 'applied',
		refusals: [],
		leftovers: {},
	}),
}))
vi.mock('#worker/org-transfer/effects.ts', () => ({
	defaultOrgTransferEffects: () => ({}),
}))
vi.mock('#mcp/memory/memory-vectorize.ts', () => ({
	deleteMemoryVector: async () => {},
	upsertMemoryVector: async () => {},
}))
vi.mock('#worker/jobs/inspect.ts', () => ({
	listJobs: async () => [{ id: 'job-1' }],
}))
vi.mock('#worker/run-records/service.ts', () => ({
	runLogRpc: () => ({
		countRunHistory: async () => 3,
		exportRunHistoryPage: async () => ({ runs: [], nextAfterId: null }),
		importRunHistory: async () => ({ imported: 0 }),
	}),
}))
const env = vi.hoisted(() => ({ current: {} as Env }))
vi.mock('../../start/server/request-env.ts', () => ({
	getStartRequestEnv: () => env.current,
}))

const { handleGuestClaimPost } =
	await import('../../start/server/guest-claim-protocol.ts')
const { guestClaimFinishCapability, guestClaimStartCapability } =
	await import('#mcp/capabilities/account/guest-claim.ts')

const baseUrl = 'https://kody.test'
const start = new Date('2026-11-04T07:00:00.000Z')

async function setup() {
	mocks.dispatch.mockClear()
	mocks.deleteUserAccount.mockClear()
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	const db = createD1FromSqlite(sqlite)
	env.current = {
		APP_DB: db,
		APP_BASE_URL: baseUrl,
		COOKIE_SECRET: testCookieSecret,
	} as unknown as Env
	const created = await createGuestAccount({
		db,
		requestIp: '203.0.113.7',
		clientName: 'Test Agent',
		now: start,
	})
	if (!created.ok) throw new Error('guest was not created')
	const org = created.personalOrgId
	sqlite.exec(`
		INSERT INTO saved_packages (id, user_id, name, kody_id, description, source_id, has_app)
		VALUES ('pkg-1', '${org}', '@guest/notes', 'notes', '', 'src-1', 1),
		       ('pkg-2', '${org}', '@guest/tool', 'tool', '', 'src-2', 0);
		INSERT INTO user_repos (id, user_id, name) VALUES ('repo-1', '${org}', 'scratch');
		INSERT INTO mcp_memories (id, user_id, subject, summary)
		VALUES ('mem-1', '${org}', 'Likes', 'Tea'), ('mem-2', '${org}', 'Uses', 'Vim');
		INSERT INTO secret_buckets (id, user_id, scope, binding_key) VALUES ('bucket-1', '${org}', 'user', '');
		INSERT INTO secret_entries (bucket_id, name, encrypted_value) VALUES ('bucket-1', 'apiKey', 'enc');
		INSERT INTO mcp_server_settings (id, user_id, name, url) VALUES ('mcp-1', '${org}', 'docs', 'https://mcp.example.test');
		INSERT INTO webhook_endpoints (id, user_id, package_id, webhook_name, url_secret_hash, created_at, rotated_at)
		VALUES ('hook-1', '${org}', 'pkg-1', 'inbound', 'hash', '${start.toISOString()}', '${start.toISOString()}');
	`)
	const guest = await readGuestAccountByPerson(db, created.personId)
	if (!guest) throw new Error('guest row missing')
	return { sqlite, db, guest, created }
}

const seededCounts = {
	packages: 2,
	repos: 1,
	memories: 2,
	secrets: 1,
	connections: 0,
	mcp_servers: 1,
	apps: 1,
	jobs: 1,
	webhooks: 1,
	runs: 3,
}

async function seedTarget(sqlite: DatabaseSync) {
	await seedUser(sqlite, {
		id: 900,
		email: 'owner@example.test',
		username: 'owner',
		emailVerified: true,
	})
	const row = sqlite
		.prepare(`SELECT stable_user_id, personal_org_id FROM users WHERE id = 900`)
		.get() as { stable_user_id: string; personal_org_id: string | null }
	const orgId =
		row.personal_org_id ?? personalOrgId(row.stable_user_id as never)
	// Same kody_id as a guest package: the merge renames it.
	sqlite.exec(`
		INSERT INTO saved_packages (id, user_id, name, kody_id, description, source_id)
		VALUES ('pkg-target', '${orgId}', '@owner/notes', 'notes', '', 'src-t');
	`)
	return { personId: row.stable_user_id, orgId }
}

function dispatchedEvents() {
	return mocks.dispatch.mock.calls.map(
		([input]) => input.event as UserLifecycleEvent,
	)
}

function claimedEvents() {
	return dispatchedEvents().filter(
		(event) => event.event === 'user.guest_claimed',
	)
}

function expectOnlyOneClaimEvent() {
	const events = dispatchedEvents()
	expect(events.map((event) => event.event)).toEqual(['user.guest_claimed'])
	return claimedEvents()[0]!
}

function claimPost(code: string, fields: Record<string, string>) {
	return handleGuestClaimPost({
		request: new Request(`${baseUrl}/claim/${code}`, {
			method: 'POST',
			headers: {
				Origin: baseUrl,
				'Content-Type': 'application/x-www-form-urlencoded',
			},
			body: new URLSearchParams(fields),
		}),
		params: { code },
	})
}

function capabilityContext(personId: string) {
	return {
		env: env.current,
		callerContext: { baseUrl, user: { userId: personId } },
	} as never
}

test('guestClaimFinish (agent) emits one user.guest_claimed for a new account', async () => {
	const { sqlite, guest, created } = await setup()
	const started = (await guestClaimStartCapability.handler(
		{ email: 'claimer@example.test', username: 'claimer' } as never,
		capabilityContext(created.personId),
	)) as { dev_code?: string | null }
	const devCode = started.dev_code
	expect(devCode).toBeTruthy()
	const result = await guestClaimFinishCapability.handler(
		{ code: String(devCode) },
		capabilityContext(created.personId),
	)
	expect(result).toMatchObject({ claimed: true, mode: 'new' })

	const event = expectOnlyOneClaimEvent()
	const claimedAt = (
		sqlite
			.prepare('SELECT claimed_at FROM guest_accounts WHERE person_id = ?')
			.get(created.personId) as { claimed_at: string }
	).claimed_at
	expect(event).toEqual({
		event: 'user.guest_claimed',
		mode: 'new',
		user_created: true,
		method: 'agent',
		provider: null,
		user: {
			id: created.personId,
			username: 'claimer',
			email: 'claimer@example.test',
		},
		guest: {
			id: created.personId,
			username: created.username,
			client_name: 'Test Agent',
			created_at: guest.createdAt,
			expires_at: guest.expiresAt,
			claimed_at: claimedAt,
			phase: expect.stringMatching(/^(active|hold)$/),
		},
		claimed_at: claimedAt,
		counts: seededCounts,
		renamed_packages: 0,
	})
	expect(JSON.stringify(event)).not.toContain(guest.claimCode)
	expect(JSON.stringify(event)).not.toContain(String(devCode))
})

test('the claim page email code (merge) emits one user.guest_claimed with counts from before the move', async () => {
	const { sqlite, guest, created } = await setup()
	const target = await seedTarget(sqlite)
	const startResponse = await claimPost(guest.claimCode, {
		action: 'email_start',
		email: 'owner@example.test',
		mode: 'merge',
	})
	const devCode = new URL(
		startResponse.headers.get('Location')!,
		baseUrl,
	).searchParams.get('dev_code')
	expect(devCode).toBeTruthy()
	const finish = await claimPost(guest.claimCode, {
		action: 'email_finish',
		email: 'owner@example.test',
		code: devCode!,
	})
	expect(finish.headers.get('Location')).toContain('result=claimed')

	const memoriesLeft = sqlite
		.prepare('SELECT COUNT(*) AS n FROM mcp_memories WHERE user_id = ?')
		.get(created.personalOrgId) as { n: number }
	expect(memoriesLeft.n).toBe(0)
	const event = expectOnlyOneClaimEvent()
	expect(event).toMatchObject({
		mode: 'merge',
		user_created: false,
		method: 'email_code',
		provider: null,
		user: {
			id: target.personId,
			username: 'owner',
			email: 'owner@example.test',
		},
		guest: { id: created.personId, username: created.username },
		counts: seededCounts,
		renamed_packages: 1,
	})
	expect(event.claimed_at).toBe(event.guest.claimed_at)
	expect(mocks.deleteUserAccount).toHaveBeenCalledOnce()
	expect(JSON.stringify(event)).not.toContain(devCode!)
})

test('signed-in merge on the claim page emits one user.guest_claimed and no user.deleted', async () => {
	const { sqlite, guest, created } = await setup()
	const target = await seedTarget(sqlite)
	mocks.readAuthenticatedAppUser.mockResolvedValueOnce({
		userId: 900,
		email: 'owner@example.test',
	})
	const response = await claimPost(guest.claimCode, {
		action: 'merge_signed_in',
	})
	expect(response.headers.get('Location')).toContain('mode=merge')
	const event = expectOnlyOneClaimEvent()
	expect(event).toMatchObject({
		mode: 'merge',
		user_created: false,
		method: 'signed_in_merge',
		provider: null,
		user: { id: target.personId },
		guest: { id: created.personId, client_name: 'Test Agent' },
		counts: seededCounts,
		renamed_packages: 1,
	})
})

test('a failing dispatch never fails the claim', async () => {
	const { guest } = await setup()
	mocks.dispatch.mockImplementationOnce(() => {
		throw new Error('dispatch exploded')
	})
	const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
	const started = await claimPost(guest.claimCode, {
		action: 'email_start',
		email: 'person@example.test',
		username: 'person',
	})
	const devCode = new URL(
		started.headers.get('Location')!,
		baseUrl,
	).searchParams.get('dev_code')!
	const finish = await claimPost(guest.claimCode, {
		action: 'email_finish',
		email: 'person@example.test',
		code: devCode,
	})
	expect(finish.headers.get('Location')).toContain('result=claimed')
	await vi.waitFor(() =>
		expect(warn).toHaveBeenCalledWith(
			'user-lifecycle-subscription-dispatch-failed',
			expect.objectContaining({ event: 'user.guest_claimed' }),
		),
	)
	warn.mockRestore()
	expect(claimedEvents()[0]).toMatchObject({
		mode: 'new',
		method: 'email_code',
	})
})
