import { DatabaseSync } from 'node:sqlite'
import { beforeEach, expect, test, vi } from 'vitest'
import { ensureOrgsTestSchema } from '#worker/orgs/orgs-test-schema.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { createMemoryKvNamespace } from '#worker/test-support/memory-kv.ts'
import { packageAppHostMigrationPatternMessages } from './codemods/0019-detect-package-app-host-migration.ts'
import type { PackageCodemodRunItemRecord } from './ledger.ts'

const mocks = vi.hoisted(() => ({
	items: [] as Array<PackageCodemodRunItemRecord>,
	sendCloudflareEmail: vi.fn(),
}))

vi.mock('./ledger.ts', () => ({
	getPackageCodemodRunById: async (_db: D1Database, runId: string) =>
		runId === 'run-1' || runId === 'run-other'
			? {
					id: runId,
					codemodId:
						runId === 'run-1'
							? '0019-detect-package-app-host-migration'
							: '0010-detect-legacy-credential-patterns',
					mode: 'scan',
					status: 'completed',
				}
			: null,
	listPackageCodemodRunItems: async (
		_db: D1Database,
		input: { runId: string; afterId?: string | null; limit?: number },
	) =>
		mocks.items
			.filter((item) => item.runId === input.runId)
			.filter((item) => item.id > (input.afterId ?? ''))
			.slice(0, input.limit ?? 50),
}))

vi.mock('#app/email/cloudflare-email.ts', () => ({
	sendCloudflareEmail: (...args: Array<unknown>) =>
		mocks.sendCloudflareEmail(...args),
}))

const { runPackageAppHostMigrationNotice } =
	await import('./host-migration-owner-notice.ts')
const { packageOwnerNoticeKvKey } = await import('./owner-notice.ts')

const messages = packageAppHostMigrationPatternMessages

function item(
	id: string,
	ownerId: string,
	name: string,
	findings: Array<string>,
) {
	return {
		id,
		runId: 'run-1',
		packageId: `pkg-${name}`,
		userId: ownerId,
		kodyId: name.split('/')[1],
		status: 'detected',
		findings: findings.map((message) => ({ message })),
	} as unknown as PackageCodemodRunItemRecord
}

async function createEnv() {
	const db = createD1FromSqlite(new DatabaseSync(':memory:'))
	await ensureOrgsTestSchema(db)
	await db
		.prepare(
			`CREATE TABLE users (
				id INTEGER PRIMARY KEY,
				stable_user_id TEXT NOT NULL UNIQUE,
				email TEXT,
				display_name TEXT,
				username TEXT,
				email_verified_at TEXT,
				deleting_at TEXT,
				deleted_at TEXT
			)`,
		)
		.run()
	await db
		.prepare('CREATE TABLE saved_packages (id TEXT PRIMARY KEY, name TEXT)')
		.run()
	for (const [id, name] of [
		['alice', 'Alice A'],
		['bob', null],
		['carol', 'Carol'],
	] as const) {
		await db
			.prepare(
				`INSERT INTO users (stable_user_id, email, display_name, username, email_verified_at)
				 VALUES (?, ?, ?, ?, '2026-01-01')`,
			)
			.bind(id, `${id}@example.com`, name, id)
			.run()
	}
	for (const packageItem of mocks.items) {
		await db
			.prepare('INSERT INTO saved_packages (id, name) VALUES (?, ?)')
			.bind(packageItem.packageId, packageItem.packageId.slice(4))
			.run()
	}
	const { kv } = createMemoryKvNamespace()
	const env = {
		APP_DB: db,
		BUNDLE_ARTIFACTS_KV: kv,
		CLOUDFLARE_ACCOUNT_ID: 'acct',
		CLOUDFLARE_API_BASE_URL: 'https://api.cloudflare.com/client/v4',
		CLOUDFLARE_API_TOKEN: 'token',
		APP_BASE_URL: 'https://kody.test',
		PACKAGE_APP_BASE_URL: 'https://kody.run',
		SYSTEM_EMAIL_DOMAIN: 'kody.codes',
	} as unknown as Env
	return { env, kv }
}

const base = {
	runId: 'run-1',
	noticeId: '2026-12-app-hosts',
	kind: 'announce' as const,
	cutoverDate: 'January 15, 2027',
	reminderDate: 'January 8, 2027',
}

beforeEach(() => {
	mocks.sendCloudflareEmail.mockReset()
	mocks.sendCloudflareEmail.mockResolvedValue({ ok: true })
	mocks.items = [
		item('01', 'alice', '@alice/notes', [messages.localStorage]),
		item('02', 'bob', '@bob/shop', [
			messages['hardcoded mount path'],
			messages['oauth redirect uri'],
		]),
		item('03', 'bob', '@bob/mailer', [messages['list-unsubscribe']]),
		item('04', 'bob', '@bob/hooks', [
			messages['webhook receiver'],
			messages['declared kody webhook'],
		]),
		item('05', 'bob', '@bob/bob', [messages.indexedDB]),
		item('06', 'carol', '@carol/relay', [messages['webhook receiver']]),
		item('07', 'carol', '@carol/plain', [messages.sessionStorage]),
	]
})

test('dry run counts owners and apps by category and previews the first email without sending', async () => {
	const { env, kv } = await createEnv()

	const result = await runPackageAppHostMigrationNotice({
		env,
		...base,
		dryRun: true,
	})

	expect(result.totals).toEqual({
		recipients: { owners: 2, apps: 2 },
		byCategory: {
			browserData: { owners: 1, apps: 1 },
			addressCode: { owners: 1, apps: 1 },
			outsideRequests: { owners: 1, apps: 2 },
		},
		outsideOnly: { owners: 1, apps: 1 },
		appsWithoutNewHost: 1,
	})
	expect(result.summary).toEqual({ would_send: 2 })
	expect(result.owners.map((owner) => owner.ownerId)).toEqual(['alice', 'bob'])
	expect(result.owners[0]!.apps).toEqual([
		{
			packageId: 'pkg-@alice/notes',
			name: '@alice/notes',
			oldUrl: 'https://alice.kody.run/notes/',
			newUrl: 'https://notes--alice.kody.run/',
			categories: ['browserData'],
			outside: [],
		},
	])
	const text = result.preview!.text
	expect(text).toContain('Hi Alice A,')
	expect(text).toContain(
		'@alice/notes: old https://alice.kody.run/notes/, new https://notes--alice.kody.run/',
	)
	expect(text).toContain('On January 15, 2027 the old address stops serving')
	expect(text).toContain('We will send one reminder on January 8, 2027.')
	expect(text).toContain('create a package named @alice/alice')
	expect(text).toContain(
		'My Kody package app @alice/notes is moving to a new browser origin.',
	)
	expect(text).toContain('  OLD: https://alice.kody.run/notes/\n')
	expect(text).not.toContain('@{owner}')
	expect(text).not.toContain('{cutover date}')
	expect(text).not.toContain('--app-base-path /{app}')
	expect(text).not.toContain('outside services at the old address')
	expect(text).not.toContain('\u2014')
	expect(mocks.sendCloudflareEmail).not.toHaveBeenCalled()
	expect(
		await kv.get(
			packageOwnerNoticeKvKey({
				noticeId: base.noticeId,
				ownerId: 'alice',
				recipientUserId: 'alice',
			}),
		),
	).toBeNull()
})

test('an owner with several apps gets the outside-requests paragraph and an unfilled {app}', async () => {
	mocks.items.push(item('08', 'bob', '@bob/board', [messages['cookie path']]))
	const { env } = await createEnv()

	const result = await runPackageAppHostMigrationNotice({
		env,
		...base,
		dryRun: true,
		cursor: 'alice',
	})

	const text = result.preview!.text
	expect(text).toContain('Hi bob,')
	expect(text).toContain('@bob/board: old https://bob.kody.run/board/')
	expect(text).toContain('@bob/shop: old https://bob.kody.run/shop/')
	expect(text).not.toContain('@bob/hooks')
	expect(text).toContain(
		'@bob/mailer (unsubscribe links in email it sends); @bob/shop (an OAuth sign-in callback)',
	)
	expect(text).toContain('replace {app} with')
	expect(text).toContain('My Kody package app @bob/{app} is moving')
})

test('the reminder repeats the visit line and the cutover date', async () => {
	const { env } = await createEnv()

	const result = await runPackageAppHostMigrationNotice({
		env,
		...base,
		noticeId: '2027-01-app-hosts-reminder',
		kind: 'reminder',
		dryRun: true,
	})

	expect(result.preview!.subject).toBe(
		'One week left: your Kody apps move on January 15, 2027',
	)
	expect(result.preview!.text).toContain(
		'has to open your app at the old address at least once after the update ships, before January 15, 2027',
	)
})

test('sending emails each recipient once per notice id', async () => {
	const { env } = await createEnv()

	const first = await runPackageAppHostMigrationNotice({
		env,
		...base,
		dryRun: false,
	})
	const second = await runPackageAppHostMigrationNotice({
		env,
		...base,
		dryRun: false,
	})

	expect(first.summary).toEqual({ sent: 2 })
	expect(second.summary).toEqual({ already_sent: 2 })
	expect(mocks.sendCloudflareEmail).toHaveBeenCalledTimes(2)
})

test('a scan of another codemod is refused', async () => {
	const { env } = await createEnv()

	await expect(
		runPackageAppHostMigrationNotice({
			env,
			...base,
			runId: 'run-other',
			dryRun: true,
		}),
	).rejects.toThrow(
		'This notice needs a scan run of 0019-detect-package-app-host-migration.',
	)
})
