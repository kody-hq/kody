import { expect, test, vi } from 'vitest'
import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { type RunRecord } from '#worker/run-records/types.ts'
import { buildWebhookRejectionReport } from './rejection-report.ts'

const mocks = vi.hoisted(() => ({
	listRunRecords: vi.fn(),
}))

vi.mock('#worker/run-records/service.ts', () => ({
	listRunRecords: mocks.listRunRecords,
}))

function run(input: {
	ownerName: string
	startedAt: string
	name: string
	status: 'success' | 'error'
	httpStatus: number
	error?: string
}): RunRecord {
	return {
		id: crypto.randomUUID(),
		surface: 'webhook',
		status: input.status,
		name: input.name,
		packageId: `pkg-${input.name}`,
		kodyId: input.name,
		sourceId: null,
		publishedCommit: null,
		storageId: null,
		jobId: null,
		workflowId: null,
		invocationId: null,
		sessionId: null,
		idempotencyKey: null,
		parentRunId: null,
		startedAt: input.startedAt,
		finishedAt: null,
		durationMs: null,
		errorName: null,
		errorMessage: input.error ?? null,
		errorTriage: null,
		triageNote: null,
		triagedAt: null,
		triagedBy: null,
		startedBy: null,
		metadata: {
			endpointId: `${input.ownerName}-${input.name}`,
			httpStatus: input.httpStatus,
		},
		logCount: 0,
	}
}

test('the report counts matching rejections per endpoint and owner, with deliveries in the same window', async () => {
	const runsByOwner: Record<string, Array<RunRecord>> = {
		'org-kent': [
			run({
				ownerName: 'kent',
				startedAt: '2026-10-12T05:00:00.000Z',
				name: 'wake',
				status: 'success',
				httpStatus: 202,
			}),
			run({
				ownerName: 'kent',
				startedAt: '2026-10-12T03:00:00.000Z',
				name: 'wake',
				status: 'error',
				httpStatus: 401,
				error: 'missing_signature',
			}),
			run({
				ownerName: 'kent',
				startedAt: '2026-10-11T10:00:00.000Z',
				name: 'wake',
				status: 'error',
				httpStatus: 401,
				error: 'missing_signature',
			}),
			run({
				ownerName: 'kent',
				startedAt: '2026-10-11T11:00:00.000Z',
				name: 'github',
				status: 'error',
				httpStatus: 401,
				error: 'invalid_signature',
			}),
			{
				...run({
					ownerName: 'kent',
					startedAt: '2026-10-11T12:00:00.000Z',
					name: 'wake',
					status: 'error',
					httpStatus: 401,
					error: 'missing_signature',
				}),
				metadata: {
					endpointId: 'kent-wake',
					httpStatus: 401,
					synthetic: true,
				},
			},
		],
		'org-ada': [
			run({
				ownerName: 'ada',
				startedAt: '2026-10-11T12:00:00.000Z',
				name: 'stripe',
				status: 'error',
				httpStatus: 401,
				error: 'missing_signature',
			}),
		],
		'org-quiet': [],
	}
	mocks.listRunRecords.mockImplementation(
		async (input: {
			userId: string
			filter: { since: string; until?: string | null }
		}) => ({
			runs: runsByOwner[input.userId]!.filter((entry) => {
				if (entry.startedAt < input.filter.since) return false
				if (input.filter.until && entry.startedAt >= input.filter.until) {
					return false
				}
				return true
			}),
			nextCursor: null,
		}),
	)
	const env = {
		APP_DB: {
			prepare() {
				const statement = {
					bind() {
						return statement
					},
					async all() {
						return {
							results: [
								{ owner_id: 'org-ada', slug: 'ada' },
								{ owner_id: 'org-kent', slug: 'kentcdodds' },
								{ owner_id: 'org-quiet', slug: 'quiet' },
							],
						}
					},
				}
				return statement
			},
		},
	} as unknown as Env

	const report = await buildWebhookRejectionReport({
		env,
		since: '2026-10-11T06:56:00.000Z',
		httpStatus: 401,
		error: 'missing_signature',
	})

	expect(report).toMatchObject({
		ownersScanned: 3,
		ownersFailed: [],
		truncated: false,
		totals: { owners: 2, endpoints: 2, rejected: 3 },
		owners: [
			{ ownerId: 'org-kent' as OwnerId, ownerSlug: 'kentcdodds', rejected: 2 },
			{ ownerId: 'org-ada' as OwnerId, ownerSlug: 'ada', rejected: 1 },
		],
	})
	expect(report.endpoints[0]).toMatchObject({
		ownerSlug: 'kentcdodds',
		packageKodyId: 'wake',
		webhookName: 'wake',
		rejected: 2,
		delivered: 1,
		otherErrors: 0,
		firstRejectedAt: '2026-10-11T10:00:00.000Z',
		lastRejectedAt: '2026-10-12T03:00:00.000Z',
		lastDeliveredAt: '2026-10-12T05:00:00.000Z',
	})

	const untilFix = await buildWebhookRejectionReport({
		env,
		since: '2026-10-11T00:56:00-06:00',
		until: '2026-10-11T22:00:00-06:00',
		httpStatus: 401,
	})
	expect(untilFix).toMatchObject({
		since: '2026-10-11T06:56:00.000Z',
		until: '2026-10-12T04:00:00.000Z',
	})
	expect(untilFix.totals).toEqual({ owners: 2, endpoints: 3, rejected: 4 })
	expect(
		untilFix.endpoints.find((row) => row.webhookName === 'wake')?.delivered,
	).toBe(0)
	expect(mocks.listRunRecords).toHaveBeenCalledWith(
		expect.objectContaining({
			filter: expect.objectContaining({
				since: '2026-10-11T06:56:00.000Z',
				until: '2026-10-12T04:00:00.000Z',
				surface: 'webhook',
			}),
		}),
	)
})
