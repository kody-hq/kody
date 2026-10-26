import { expect, test, vi } from 'vitest'
import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { type RunRecord } from '#worker/run-records/types.ts'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import {
	checkWebhookAuthRegressionsAndAlert,
	classifyWebhookAuthRegression,
	webhookAuthRegressionKvKeyPrefix,
} from './auth-regression-alert.ts'
import { toWebhookDelivery } from './delivery-outcomes.ts'

const mocks = vi.hoisted(() => ({
	listRunRecords: vi.fn(),
	captureMessage: vi.fn(),
	setFingerprint: vi.fn(),
}))

vi.mock('#worker/run-records/service.ts', () => ({
	listRunRecords: mocks.listRunRecords,
}))

vi.mock('@sentry/cloudflare', () => ({
	captureMessage: mocks.captureMessage,
	withScope: (callback: (scope: unknown) => void) =>
		callback({
			setLevel() {},
			setTag() {},
			setContext() {},
			setFingerprint: mocks.setFingerprint,
		}),
}))

const ownerId = 'org-kent' as OwnerId
const owner = { ownerId, slug: 'kentcdodds' }
const now = new Date('2026-10-12T04:00:00.000Z')

function run(
	minutesAgo: number,
	outcome: 'delivered' | { status: number; error: string },
	overrides: Partial<RunRecord> = {},
): RunRecord {
	const delivered = outcome === 'delivered'
	return {
		id: crypto.randomUUID(),
		surface: 'webhook',
		status: delivered ? 'success' : 'error',
		name: 'wake',
		packageId: 'pkg-grok',
		kodyId: 'grok-bot',
		sourceId: null,
		publishedCommit: null,
		storageId: null,
		jobId: null,
		workflowId: null,
		invocationId: null,
		sessionId: null,
		idempotencyKey: null,
		parentRunId: null,
		startedAt: new Date(now.getTime() - minutesAgo * 60_000).toISOString(),
		finishedAt: null,
		durationMs: null,
		errorName: null,
		errorMessage: delivered ? null : outcome.error,
		errorTriage: null,
		triageNote: null,
		triagedAt: null,
		triagedBy: null,
		startedBy: null,
		metadata: {
			endpointId: 'ep-wake',
			httpStatus: delivered ? 202 : outcome.status,
		},
		logCount: 0,
		...overrides,
	}
}

const missingSignature = { status: 401, error: 'missing_signature' }

function classify(runs: Array<RunRecord>) {
	return classifyWebhookAuthRegression({
		owner,
		deliveries: runs.map(toWebhookDelivery),
		minStreak: 3,
	})
}

test('a run of 401s that ends at a success is an auth regression', () => {
	expect(
		classify([
			run(5, missingSignature),
			run(30, missingSignature),
			run(90, { status: 401, error: 'invalid_signature' }),
			run(600, 'delivered'),
		]),
	).toMatchObject({
		ownerSlug: 'kentcdodds',
		endpointId: 'ep-wake',
		packageKodyId: 'grok-bot',
		webhookName: 'wake',
		unauthorizedStreak: 3,
		errors: { missing_signature: 2, invalid_signature: 1 },
		lastUnauthorizedAt: run(5, missingSignature).startedAt,
		firstUnauthorizedAt: run(90, missingSignature).startedAt,
		lastDeliveredAt: run(600, 'delivered').startedAt,
	})
})

test('short streaks, never-delivered webhooks, and mixed failures are not auth regressions', () => {
	expect(
		classify([
			run(5, missingSignature),
			run(30, missingSignature),
			run(60, 'delivered'),
		]),
	).toBeNull()
	expect(
		classify([
			run(5, missingSignature),
			run(30, missingSignature),
			run(60, missingSignature),
		]),
	).toBeNull()
	expect(
		classify([
			run(5, missingSignature),
			run(30, missingSignature),
			run(45, { status: 409, error: 'enablement_not_on' }),
			run(60, missingSignature),
			run(90, 'delivered'),
		]),
	).toBeNull()
})

function createKv() {
	const store = new Map<string, string>()
	return {
		store,
		async get(key: string) {
			return store.get(key) ?? null
		},
		async put(key: string, value: string) {
			store.set(key, value)
		},
	}
}

function createEnv(kv: ReturnType<typeof createKv>) {
	const db = {
		prepare() {
			const statement = {
				bind() {
					return statement
				},
				async all() {
					return { results: [{ owner_id: ownerId, slug: 'kentcdodds' }] }
				},
			}
			return statement
		},
	}
	return { APP_DB: db, BUNDLE_ARTIFACTS_KV: kv } as unknown as Env
}

test('the hourly check alerts once per regressed endpoint and then cools down', async () => {
	const history = [
		run(5, missingSignature),
		run(20, missingSignature),
		run(40, missingSignature),
		run(180, 'delivered'),
	]
	mocks.listRunRecords.mockImplementation(
		async (input: { filter: { status?: string; name?: string } }) => ({
			runs:
				input.filter.status === 'error'
					? history.filter((entry) => entry.status === 'error').slice(0, 3)
					: history,
			nextCursor: null,
		}),
	)
	consoleWarn.mockImplementation(() => {})
	const kv = createKv()
	const env = createEnv(kv)

	const first = await checkWebhookAuthRegressionsAndAlert({ env, now })
	expect(first).toMatchObject({
		ownersScanned: 1,
		ownersFailed: 0,
		candidates: 1,
		alerted: 1,
		cooldown: 0,
	})
	expect(first.regressions).toHaveLength(1)
	expect(mocks.captureMessage).toHaveBeenCalledTimes(1)
	expect(mocks.captureMessage.mock.calls[0]?.[0]).toContain(
		'kentcdodds/grok-bot/wake went from successes to 3 straight 401s (missing_signature)',
	)
	expect(consoleWarn).toHaveBeenCalledWith(
		'webhook-auth-regression-alerted',
		expect.objectContaining({ label: 'kentcdodds/grok-bot/wake' }),
	)
	expect(mocks.setFingerprint).toHaveBeenCalledWith([
		'webhook-auth-regression',
		'ep-wake',
	])
	expect(kv.store.get(`${webhookAuthRegressionKvKeyPrefix}ep-wake`)).toBe(
		String(now.getTime()),
	)
	expect(mocks.listRunRecords).toHaveBeenCalledWith(
		expect.objectContaining({
			userId: ownerId,
			filter: expect.objectContaining({
				surface: 'webhook',
				packageId: 'pkg-grok',
				name: 'wake',
			}),
		}),
	)

	const second = await checkWebhookAuthRegressionsAndAlert({
		env,
		now: new Date(now.getTime() + 60 * 60_000),
	})
	expect(second).toMatchObject({ alerted: 0, cooldown: 1 })
	expect(mocks.captureMessage).toHaveBeenCalledTimes(1)
})

test('successes from a replaced endpoint or a synthetic smoke test do not count as the webhook delivering', async () => {
	const reminted = { metadata: { endpointId: 'ep-wake-2', httpStatus: 401 } }
	const history = [
		run(5, missingSignature, reminted),
		run(20, missingSignature, reminted),
		run(40, missingSignature, reminted),
		run(60, 'delivered', {
			metadata: { endpointId: 'ep-wake-2', httpStatus: 202, synthetic: true },
		}),
		run(180, 'delivered'),
	]
	mocks.listRunRecords.mockImplementation(
		async (input: { filter: { status?: string } }) => ({
			runs:
				input.filter.status === 'error'
					? history.filter((entry) => entry.status === 'error')
					: history,
			nextCursor: null,
		}),
	)
	expect(
		await checkWebhookAuthRegressionsAndAlert({
			env: createEnv(createKv()),
			now,
		}),
	).toMatchObject({ candidates: 1, alerted: 0, regressions: [] })
	expect(mocks.captureMessage).not.toHaveBeenCalled()
})

test('an owner with no recent 401s is never paged and a failing owner is counted', async () => {
	mocks.listRunRecords.mockResolvedValueOnce({ runs: [], nextCursor: null })
	const kv = createKv()
	expect(
		await checkWebhookAuthRegressionsAndAlert({ env: createEnv(kv), now }),
	).toMatchObject({ candidates: 0, alerted: 0, ownersFailed: 0 })

	consoleWarn.mockImplementation(() => {})
	mocks.listRunRecords.mockRejectedValueOnce(new Error('RunLog down'))
	expect(
		await checkWebhookAuthRegressionsAndAlert({ env: createEnv(kv), now }),
	).toMatchObject({ alerted: 0, ownersFailed: 1 })
	expect(consoleWarn).toHaveBeenCalledWith(
		'webhook-auth-regression-owner-failed',
		expect.objectContaining({ ownerId }),
	)
	expect(mocks.captureMessage).not.toHaveBeenCalled()
})
