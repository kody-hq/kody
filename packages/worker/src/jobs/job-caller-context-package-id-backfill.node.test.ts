import { expect, test, vi } from 'vitest'
import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { buildPackageJobId } from '@kody-internal/shared/jobs/package-job-id.ts'
import {
	backfillJobCallerContextPackageIds,
	jobCallerContextNeedsPackageIdRepair,
} from './job-caller-context-package-id-backfill.ts'

const mockListJobsPage = vi.hoisted(() => vi.fn())
const mockUpdateJob = vi.hoisted(() => vi.fn())
const mockCreatePackageJobCallerContext = vi.hoisted(() => vi.fn())
const mockSerializeCallerContext = vi.hoisted(() =>
	vi.fn((ctx: unknown) => JSON.stringify(ctx)),
)

vi.mock('./jobs-data.ts', () => ({
	jobsData: () => ({
		listJobsPage: mockListJobsPage,
		updateJob: mockUpdateJob,
	}),
}))

vi.mock('./service.ts', () => ({
	createPackageJobCallerContext: mockCreatePackageJobCallerContext,
	serializeCallerContext: mockSerializeCallerContext,
}))

const packageId = 'pkg-repair-1'
const jobName = 'nightly'
const jobId = buildPackageJobId(packageId, jobName)
const orgId = ownerIdFromStored('user-repair')

function damagedRow() {
	return {
		id: jobId,
		user_id: String(orgId),
		name: jobName,
		deleted_at: null,
		caller_context_json: JSON.stringify({
			baseUrl: 'https://example.com',
			executionOrigin: 'interactive',
			user: { userId: personIdFromStored('user-repair') },
			storageContext: {
				sessionId: 'sess-1',
				appId: null,
				packageId: null,
				storageId: null,
			},
		}),
		record: {
			id: jobId,
			userId: orgId,
			name: jobName,
			sourceId: 'source-1',
			publishedCommit: 'commit-1',
			storageId: `job:${jobId}`,
			schedule: { type: 'interval', every: '1h' },
			timezone: 'UTC',
			enabled: true,
			killSwitchEnabled: false,
			expiresAt: null,
			createdAt: '2026-10-19T00:00:00.000Z',
			updatedAt: '2026-10-19T00:00:00.000Z',
			nextRunAt: '2026-10-20T00:00:00.000Z',
			runCount: 0,
			successCount: 0,
			errorCount: 0,
		},
	}
}

test('jobCallerContextNeedsPackageIdRepair detects missing and mismatched package ids', () => {
	expect(
		jobCallerContextNeedsPackageIdRepair({
			jobId,
			callerContextJson: damagedRow().caller_context_json,
		}),
	).toEqual({ needsRepair: true, packageId })
	expect(
		jobCallerContextNeedsPackageIdRepair({
			jobId,
			callerContextJson: JSON.stringify({
				storageContext: { packageId },
			}),
		}),
	).toEqual({ needsRepair: false, packageId })
	expect(
		jobCallerContextNeedsPackageIdRepair({
			jobId: 'not-a-package-job',
			callerContextJson: '{}',
		}),
	).toEqual({ needsRepair: false, packageId: null })
})

test('backfill dryRun counts repairs without writing; apply rebuilds package caller context', async () => {
	const env = { APP_DB: {} } as Env
	const rebuilt = {
		baseUrl: 'https://example.com',
		executionOrigin: 'background',
		user: { userId: personIdFromStored('user-repair') },
		storageContext: {
			sessionId: null,
			appId: packageId,
			packageId,
			storageId: null,
		},
		repoContext: null,
	}
	mockCreatePackageJobCallerContext.mockResolvedValue(rebuilt)
	mockUpdateJob.mockResolvedValue(true)

	mockListJobsPage.mockResolvedValueOnce([damagedRow()])
	const dry = await backfillJobCallerContextPackageIds({
		env,
		dryRun: true,
		baseUrl: 'https://example.com',
	})
	expect(dry.counts).toMatchObject({
		scanned: 1,
		repaired: 1,
		alreadyOk: 0,
		failed: 0,
	})
	expect(mockUpdateJob).not.toHaveBeenCalled()
	expect(mockCreatePackageJobCallerContext).not.toHaveBeenCalled()

	mockListJobsPage.mockResolvedValueOnce([damagedRow()])
	const applied = await backfillJobCallerContextPackageIds({
		env,
		dryRun: false,
		baseUrl: 'https://example.com',
	})
	expect(applied.counts.repaired).toBe(1)
	expect(mockCreatePackageJobCallerContext).toHaveBeenCalledWith(
		expect.objectContaining({
			packageId,
			userId: orgId,
			baseUrl: 'https://example.com',
		}),
	)
	expect(mockUpdateJob).toHaveBeenCalledWith(
		expect.objectContaining({
			userId: orgId,
			callerContextJson: JSON.stringify(rebuilt),
		}),
	)

	mockListJobsPage.mockResolvedValueOnce([
		{
			...damagedRow(),
			caller_context_json: JSON.stringify({
				storageContext: { packageId },
			}),
		},
	])
	const again = await backfillJobCallerContextPackageIds({
		env,
		dryRun: false,
		baseUrl: 'https://example.com',
	})
	expect(again.counts).toMatchObject({
		repaired: 0,
		alreadyOk: 1,
	})
})
