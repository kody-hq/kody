import { DatabaseSync } from 'node:sqlite'
import { beforeEach, expect, test, vi } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'

const kodyOrgId = 'c'.repeat(64)
const otherOrgId = 'd'.repeat(64)
const signupId = 'b'.repeat(64)
const now = new Date('2026-11-16T12:00:00.000Z')

const mocks = vi.hoisted(() => ({
	listSavedPackagesByUserId: vi.fn(),
	invokePackageSubscription: vi.fn(),
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	listSavedPackagesByUserId: mocks.listSavedPackagesByUserId,
	listSavedPackagesByIds: vi.fn(async () => []),
}))
vi.mock('#worker/package-invocations/service.ts', () => ({
	invokePackageSubscription: mocks.invokePackageSubscription,
}))
vi.mock('#worker/dynamic-worker-evaluation-budget.ts', () => ({
	runQueueableDynamicWorkerWork: async (work: () => Promise<unknown>) =>
		await work(),
}))
vi.mock(
	'#worker/package-invocations/saved-package-manifest-discovery.ts',
	() => ({
		mapSettledInChunks: async <T, R>(
			items: ReadonlyArray<T>,
			map: (item: T) => Promise<R>,
		) => await Promise.allSettled(items.map(map)),
		loadManifestsForSavedPackages: async (input: {
			savedPackages: ReadonlyArray<{ id: string }>
		}) =>
			input.savedPackages.map((savedPackage) => ({
				status: 'fulfilled' as const,
				value: {
					savedPackage,
					manifest: {
						name: `@org/${savedPackage.id}`,
						exports: { '.': './index.js' },
						kody: {
							id: savedPackage.id,
							description: 'Consent fixture',
							subscriptions: {
								'whats_new.consent.changed': { handler: './src/on-consent.ts' },
							},
						},
					},
				},
			})),
	}),
)

const { deliverWhatsNewConsentOutboxRow, recordWhatsNewConsentChange } =
	await import('./consent-outbox.ts')
const { firstPartyOrgIds } = await import('#worker/first-party-orgs.ts')

function setup(packageOwners: Array<string>) {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	const env = {
		APP_DB: createD1FromSqlite(sqlite),
		APP_BASE_URL: 'https://kody.example.com',
		PACKAGE_EVENTS_DISPATCH_QUEUE: { send: vi.fn(async () => {}) },
		FIRST_PARTY_ORG_IDS: kodyOrgId,
	} as unknown as Env
	sqlite
		.prepare(
			`INSERT INTO newsletter_signups (stable_id, email, status, requested_at, confirmed_at, updated_at) VALUES (?, 'guest@example.com', 'confirmed', ?, ?, ?)`,
		)
		.run(signupId, now.toISOString(), now.toISOString(), now.toISOString())
	mocks.listSavedPackagesByUserId.mockImplementation(
		async (_db: unknown, input: { userId: string }) =>
			packageOwners
				.filter((owner) => owner === input.userId)
				.map((owner) => ({
					id: `pkg-${owner.slice(0, 4)}`,
					userId: owner,
					kodyId: 'newsletter',
					sourceId: `source-${owner.slice(0, 4)}`,
				})),
	)
	const outbox = () =>
		sqlite
			.prepare(`SELECT id, attempts FROM whats_new_consent_outbox`)
			.all() as Array<{ id: string; attempts: number }>
	const record = async () => {
		await recordWhatsNewConsentChange({
			env,
			stableUserId: signupId,
			optedIn: true,
			source: 'newsletter_page',
			occurredAt: now.toISOString(),
			now,
		})
		return outbox()[0]!.id
	}
	return { env, outbox, record }
}

beforeEach(() => {
	mocks.listSavedPackagesByUserId.mockReset()
	mocks.invokePackageSubscription.mockReset()
	mocks.invokePackageSubscription.mockResolvedValue({
		status: 200,
		body: { ok: true },
	})
})

test('only well-formed org ids are read from the allowlist', () => {
	expect(
		firstPartyOrgIds({
			FIRST_PARTY_ORG_IDS: ` ${kodyOrgId}, kody ,`,
		}),
	).toEqual([kodyOrgId])
	expect(firstPartyOrgIds({})).toEqual([])
})

test('a package owned by the allowlisted kody org receives the consent change', async () => {
	const { env, outbox, record } = setup([kodyOrgId])
	const outboxId = await record()
	await expect(
		deliverWhatsNewConsentOutboxRow({ env, outboxId }),
	).resolves.toEqual({ delivered: 1 })
	expect(mocks.invokePackageSubscription).toHaveBeenCalledTimes(1)
	expect(mocks.invokePackageSubscription.mock.calls[0]![0]).toMatchObject({
		savedPackage: { userId: kodyOrgId },
		topic: 'whats_new.consent.changed',
		params: {
			event_id: outboxId,
			subscriber: { stable_user_id: signupId, email: 'guest@example.com' },
			consent: {
				opted_in: true,
				source: 'newsletter_page',
				occurred_at: now.toISOString(),
			},
		},
	})
	expect(outbox()).toEqual([])
})

test('a package owned by an org that is not allowlisted does not receive it, and the row stays queued', async () => {
	const { env, outbox, record } = setup([otherOrgId])
	const outboxId = await record()
	await expect(
		deliverWhatsNewConsentOutboxRow({ env, outboxId }),
	).resolves.toEqual({ delivered: 0 })
	expect(mocks.listSavedPackagesByUserId).not.toHaveBeenCalledWith(
		expect.anything(),
		{ userId: otherOrgId },
	)
	expect(mocks.invokePackageSubscription).not.toHaveBeenCalled()
	expect(outbox()).toEqual([{ id: outboxId, attempts: 0 }])
})

test('the row stays queued, uncounted, when nobody subscribes', async () => {
	const { env, outbox, record } = setup([])
	const outboxId = await record()
	await expect(
		deliverWhatsNewConsentOutboxRow({ env, outboxId }),
	).resolves.toEqual({ delivered: 0 })
	expect(mocks.invokePackageSubscription).not.toHaveBeenCalled()
	expect(outbox()).toEqual([{ id: outboxId, attempts: 0 }])
})

test('the row stays queued while the subscription is not turned on, then delivers', async () => {
	const { env, outbox, record } = setup([kodyOrgId])
	const outboxId = await record()
	mocks.invokePackageSubscription.mockResolvedValueOnce({
		status: 202,
		body: { ok: true, skipped: { reason: 'no_enablement_on' } },
	})
	await expect(
		deliverWhatsNewConsentOutboxRow({ env, outboxId }),
	).resolves.toEqual({ delivered: 0 })
	expect(outbox()).toEqual([{ id: outboxId, attempts: 0 }])
	await expect(
		deliverWhatsNewConsentOutboxRow({ env, outboxId }),
	).resolves.toEqual({ delivered: 1 })
	expect(outbox()).toEqual([])
})
