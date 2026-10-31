import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi, afterEach } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'
import {
	isEntitlementLimitError,
	isJobIntervalFloorError,
} from '#worker/entitlements/errors.ts'
import { planLimits } from '#universal/plans.ts'
import { syncPackageJobsForPackage, updateJob } from './service.ts'
import {
	listJobRowsByUserId,
	refreshPackageJobRowIdentity,
} from '@kody-internal/shared/jobs/repo.ts'
import { parseAuthoredPackageJson } from '#worker/package-registry/manifest.ts'
import {
	identityMockModule,
	resetJobServiceMocks,
	mockRepoPersistence,
	createDatabase,
	createJobServiceTestEnv,
	insertPublishedEntitySource,
	insertPackageJob,
	syncSinglePackageJob,
	withCallerUser,
} from '#worker/test-support/jobs-service.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'

vi.mock('#worker/repo/source-service.ts', async () =>
	(
		await import('#worker/test-support/jobs-service-mocks.ts')
	).sourceServiceMock(),
)
vi.mock('#worker/repo/source-sync.ts', async () =>
	(await import('#worker/test-support/jobs-service-mocks.ts')).sourceSyncMock(),
)
vi.mock('#worker/repo/artifact-repo-cleanup.ts', async () =>
	(
		await import('#worker/test-support/jobs-service-mocks.ts')
	).artifactRepoCleanupMock(),
)
vi.mock('#worker/repo/repo-sessions.ts', async () =>
	(
		await import('#worker/test-support/jobs-service-mocks.ts')
	).repoSessionsMock(),
)
vi.mock('#worker/repo/repo-session-do.ts', async () =>
	(
		await import('#worker/test-support/jobs-service-mocks.ts')
	).repoSessionDoMock(),
)
vi.mock('./manager-client.ts', async () =>
	(
		await import('#worker/test-support/jobs-service-mocks.ts')
	).managerClientMock(),
)
vi.mock('#worker/identity/background-mcp-user.ts', async () =>
	(
		await import('#worker/test-support/jobs-service-mocks.ts')
	).backgroundMcpUserMock(),
)
vi.mock('#worker/storage-runner.ts', async (importOriginal) =>
	(
		await import('#worker/test-support/jobs-service-mocks.ts')
	).storageRunnerMock((await importOriginal()) as Record<string, unknown>),
)
vi.mock('#worker/worker-bundler-modules.ts', async () =>
	(
		await import('#worker/test-support/jobs-service-mocks.ts')
	).workerBundlerModulesMock(),
)
vi.mock('#worker/enablements/owner-cron-enablement.ts', () => ({
	ensureOwnerCronEnablementForJob: vi.fn(async () => 'inserted'),
	backfillOwnerCronEnablements: vi.fn(),
	resolveOwnerPersonIdForCronEnablement: vi.fn(),
}))

// eslint-disable-next-line epic-web/prefer-dispose-in-tests -- this legacy suite restores global spies across many integration-style tests.
afterEach(() => {
	resetJobServiceMocks()
})

function packageManifest(input: {
	name: string
	kodyId: string
	jobs: Record<string, unknown>
}) {
	return parseAuthoredPackageJson({
		content: JSON.stringify({
			name: input.name,
			exports: { '.': './index.ts' },
			kody: {
				id: input.kodyId,
				description: `${input.kodyId} package`,
				jobs: input.jobs,
			},
		}),
	})
}

function cloudflareManifest(jobs: Record<string, unknown>) {
	return packageManifest({
		name: '@kentcdodds/cloudflare',
		kodyId: 'cloudflare',
		jobs,
	})
}

function seedPackageSource(input: {
	env: Env
	userId: string
	packageId: string
	sourceId: string
	publishedCommit: string
}) {
	return insertPublishedEntitySource({
		db: input.env.APP_DB as ReturnType<typeof createDatabase>,
		userId: input.userId,
		sourceId: input.sourceId,
		entityKind: 'package',
		entityId: input.packageId,
		publishedCommit: input.publishedCommit,
		manifestPath: 'package.json',
	})
}

/** Background identity resolves each seeded user id to its account email. */
function mockBackgroundEmails(emailsByUserId: Record<string, string>) {
	identityMockModule.resolveBackgroundMcpUser.mockImplementation(
		async (_db: D1Database, id: string) => ({
			userId: personIdFromStored(id),
			email: emailsByUserId[id] ?? `${id}@example.com`,
			username: id,
			displayName: id,
		}),
	)
}

function createPlanUserCallerContext(input: { userId: string; email: string }) {
	return withCallerUser(
		createMcpCallerContext({
			source: { kind: 'mcp-oauth' },
			baseUrl: 'https://example.com',
			user: {
				userId: personIdFromStored(input.userId),
				email: input.email,
				displayName: 'Plan User',
			},
			storageContext: {
				sessionId: null,
				appId: 'app-123',
				packageId: null,
				storageId: null,
			},
		}),
	)
}

function syncQuotaJob(input: {
	env: Env
	userId: string
	packageId: string
	schedule?: Record<string, unknown>
}) {
	return syncSinglePackageJob({
		...input,
		baseUrl: 'https://example.com',
		sourceId: `${input.packageId}-source`,
		jobName: 'quota-job',
	})
}

function expectScheduledJobLimit(
	error: unknown,
	details: { plan: string; limit: number; current: number },
) {
	if (!isEntitlementLimitError(error)) {
		throw new Error('Expected a scheduled_jobs EntitlementLimitError.')
	}
	expect(error.details).toMatchObject({
		code: 'entitlement_limit_exceeded',
		resource: 'scheduled_jobs',
		...details,
	})
}

const isIntervalFloorError = (error: unknown) => isJobIntervalFloorError(error)

test('package job sync reports scheduler changes for add, update, and remove only', async () => {
	const env = createJobServiceTestEnv({ APP_DB: createDatabase() })
	const input = {
		env,
		userId: ownerIdFromStored('user-1'),
		baseUrl: 'https://heykody.dev',
		packageId: 'package-1',
		sourceId: 'source-1',
	}
	const sync = (jobs: Record<string, unknown>) =>
		syncPackageJobsForPackage({ ...input, manifest: cloudflareManifest(jobs) })
	const listRows = () => listJobRowsByUserId(env.APP_DB, input.userId)
	await seedPackageSource({
		...input,
		publishedCommit: 'package-published-commit',
	})

	expect(await sync({})).toBe(false)

	const eventRunner = {
		entry: './src/jobs/event-runner.ts',
		schedule: { type: 'interval', every: '15m' },
		timezone: 'America/Denver',
		enabled: true,
	}
	const { ensureOwnerCronEnablementForJob } =
		await import('#worker/enablements/owner-cron-enablement.ts')
	vi.mocked(ensureOwnerCronEnablementForJob).mockClear()
	expect(await sync({ 'event-runner': eventRunner })).toBe(true)
	const [added] = await listRows()
	if (!added) throw new Error('Expected an added job row.')
	expect(await listRows()).toHaveLength(1)
	expect(added.record.publishedCommit).toBe('package-published-commit')
	expect(ensureOwnerCronEnablementForJob).toHaveBeenCalledWith(
		expect.objectContaining({
			orgId: input.userId,
			jobId: added.record.id,
			jobName: 'event-runner',
			packageId: input.packageId,
		}),
	)
	// Drift the stored identity so the no-op sync must repair it in place.
	await refreshPackageJobRowIdentity({
		db: env.APP_DB,
		userId: input.userId,
		jobId: added.record.id,
		sourceId: input.sourceId,
		publishedCommit: null,
		callerContextJson: JSON.stringify({
			...added.callerContext,
			user: { ...added.callerContext?.user, email: '' },
		}),
		updatedAt: added.record.updatedAt,
	})

	expect(await sync({ 'event-runner': eventRunner })).toBe(false)
	const [afterNoOp] = await listRows()
	expect(afterNoOp?.record.nextRunAt).toBe(added.record.nextRunAt)
	expect(afterNoOp?.record.publishedCommit).toBe('package-published-commit')
	expect(afterNoOp?.callerContext?.user.email).toBe('user-1@example.com')

	expect(
		await sync({
			'event-runner': {
				...eventRunner,
				schedule: { type: 'interval', every: '30m' },
			},
		}),
	).toBe(true)
	expect((await listRows())[0]?.record.schedule).toEqual({
		type: 'interval',
		every: '30m',
	})

	expect(await sync({})).toBe(true)
	expect(await listRows()).toEqual([])
})

test('package job sync preserves runtime enabled and does not re-enable from the manifest', async () => {
	const env = createJobServiceTestEnv({ APP_DB: createDatabase() })
	const input = {
		env,
		userId: ownerIdFromStored('user-1'),
		baseUrl: 'https://heykody.dev',
		packageId: 'package-1',
		sourceId: 'source-1',
	}
	const sync = (enabled: boolean) =>
		syncPackageJobsForPackage({
			...input,
			manifest: cloudflareManifest({
				sweep: {
					entry: './src/jobs/sweep.ts',
					schedule: { type: 'interval', every: '15m' },
					timezone: 'UTC',
					enabled,
				},
			}),
		})
	const firstRow = async () =>
		(await listJobRowsByUserId(env.APP_DB, input.userId))[0]
	await seedPackageSource({
		...input,
		publishedCommit: 'package-published-commit',
	})
	const { ensureOwnerCronEnablementForJob } =
		await import('#worker/enablements/owner-cron-enablement.ts')

	expect(await sync(false)).toBe(true)
	expect((await firstRow())?.record.enabled).toBe(false)
	const createCalls = vi.mocked(ensureOwnerCronEnablementForJob).mock.calls
		.length

	// Manifest enabled:true must not flip a disabled job on (fleet/codemod
	// republish) and must not insert/reactivate owner cron enablements.
	vi.mocked(ensureOwnerCronEnablementForJob).mockClear()
	expect(await sync(true)).toBe(false)
	expect((await firstRow())?.record.enabled).toBe(false)
	expect(ensureOwnerCronEnablementForJob).not.toHaveBeenCalled()
	expect(createCalls).toBeGreaterThan(0)

	const callerContext = createPlanUserCallerContext({
		userId: 'user-1',
		email: 'user-1@example.com',
	})
	await updateJob({
		env,
		callerContext,
		body: { id: (await firstRow())!.record.id, enabled: true },
	})
	expect((await firstRow())?.record.enabled).toBe(true)

	// Manifest enabled:false must not stop a running job.
	expect(await sync(false)).toBe(false)
	const preserved = await firstRow()
	expect(preserved?.record.enabled).toBe(true)
})

test('package job sync preflights the full addition set without partial inserts', async () => {
	const email = 'package-sync-free@example.com'
	const userId = testStableUserIdFromEmail(email)
	const now = '2026-08-08T12:00:00.000Z'
	const existingJobCount = planLimits.free.maxScheduledJobs - 1
	const db = createDatabase({
		users: [{ email, plan: 'free', stable_user_id: userId }],
		jobs: Array.from({ length: existingJobCount }, (_, index) => ({
			id: `existing-${index}`,
			user_id: userId,
			name: `Existing ${index}`,
			source_id: `existing-source-${index}`,
			published_commit: 'existing-commit',
			repo_check_policy_json: null,
			storage_id: `job:existing-${index}`,
			params_json: null,
			schedule_json: JSON.stringify({ type: 'interval', every: '1h' }),
			timezone: 'UTC',
			enabled: 1,
			kill_switch_enabled: 0,
			expires_at: null,
			caller_context_json: JSON.stringify(
				createPlanUserCallerContext({ userId, email }),
			),
			created_at: now,
			updated_at: now,
			last_run_at: null,
			last_run_status: null,
			next_run_at: '2026-08-08T13:00:00.000Z',
		})),
	})
	const env = createJobServiceTestEnv({ APP_DB: db })
	const target = {
		userId: ownerIdFromStored(userId),
		packageId: 'new-package',
		sourceId: 'new-package-source',
	}
	await seedPackageSource({
		env,
		...target,
		publishedCommit: 'new-package-commit',
	})
	const hourly = { type: 'interval', every: '1h' }

	const error = await syncPackageJobsForPackage({
		env,
		...target,
		baseUrl: 'https://heykody.dev',
		manifest: packageManifest({
			name: '@owner/new-package',
			kodyId: 'new-package',
			jobs: {
				first: { entry: './first.ts', schedule: hourly },
				second: { entry: './second.ts', schedule: hourly },
			},
		}),
	}).catch((caught: unknown) => caught)

	expectScheduledJobLimit(error, {
		plan: 'free',
		limit: planLimits.free.maxScheduledJobs,
		current: existingJobCount,
	})
	expect(await listJobRowsByUserId(db, userId)).toHaveLength(existingJobCount)
})

test('free and public Standard plans reject new or changed schedules faster than 15 minutes, preflight whole manifests, and grandfather existing jobs', async () => {
	const email = 'interval-floor@example.com'
	const userId = testStableUserIdFromEmail(email)
	const publicStandardEmail = 'public-standard-interval@example.com'
	const publicStandardUserId = testStableUserIdFromEmail(publicStandardEmail)
	const paidEmail = 'interval-floor-paid@example.com'
	const paidUserId = testStableUserIdFromEmail(paidEmail)
	mockBackgroundEmails({
		[userId]: email,
		[publicStandardUserId]: publicStandardEmail,
		[paidUserId]: paidEmail,
	})
	const env = createJobServiceTestEnv({
		APP_DB: createDatabase({
			users: [
				{ email, plan: 'free', stable_user_id: userId },
				{
					email: publicStandardEmail,
					plan: 'free',
					stripe_plan: 'standard',
					entitlement_ladder: 'public',
					stable_user_id: publicStandardUserId,
				},
				{
					email: paidEmail,
					plan: 'standard',
					stripe_plan: 'standard',
					entitlement_ladder: 'legacy',
					stable_user_id: paidUserId,
				},
			],
		}),
	})

	for (const floorUserId of [userId, publicStandardUserId]) {
		await expect(
			syncQuotaJob({
				env,
				userId: floorUserId,
				packageId: `too-fast-${floorUserId}`,
				schedule: { type: 'interval', every: '5m' },
			}),
		).rejects.toSatisfy(isIntervalFloorError)
		const created = await syncQuotaJob({
			env,
			userId: floorUserId,
			packageId: `ok-interval-${floorUserId}`,
			schedule: { type: 'interval', every: '15m' },
		})
		expect(created.schedule).toEqual({ type: 'interval', every: '15m' })
	}

	// A later too-fast job in the same manifest means nothing is written.
	const mixed = {
		userId: ownerIdFromStored(userId),
		packageId: 'mixed-interval-package',
		sourceId: 'mixed-interval-source',
	}
	await seedPackageSource({
		env,
		...mixed,
		publishedCommit: 'mixed-interval-commit',
	})
	const before = await listJobRowsByUserId(env.APP_DB, userId)
	await expect(
		syncPackageJobsForPackage({
			env,
			...mixed,
			baseUrl: 'https://example.com',
			manifest: packageManifest({
				name: '@owner/mixed-interval-package',
				kodyId: 'mixed-interval-package',
				jobs: {
					'ok-job': {
						entry: './ok.ts',
						schedule: { type: 'interval', every: '15m' },
					},
					'too-fast-job': {
						entry: './fast.ts',
						schedule: { type: 'interval', every: '5m' },
					},
				},
			}),
		}),
	).rejects.toSatisfy(isIntervalFloorError)
	expect(await listJobRowsByUserId(env.APP_DB, userId)).toEqual(before)

	const callerContext = createPlanUserCallerContext({ userId, email })
	const grandfathered = await insertPackageJob({
		env,
		callerContext,
		body: {
			name: 'five-minute-poller',
			schedule: { type: 'interval', every: '5m' },
		},
	})
	const updateGrandfathered = (body: Record<string, unknown>) =>
		updateJob({ env, callerContext, body: { id: grandfathered.id, ...body } })
	await expect(updateGrandfathered({ enabled: false })).resolves.toMatchObject({
		enabled: false,
	})
	await expect(
		updateGrandfathered({ schedule: { type: 'interval', every: '1m' } }),
	).rejects.toSatisfy(isIntervalFloorError)
	await expect(
		updateGrandfathered({ timezone: 'America/Denver' }),
	).rejects.toSatisfy(isIntervalFloorError)

	const paidCreated = await syncQuotaJob({
		env,
		userId: paidUserId,
		packageId: 'paid-fast-package',
		schedule: { type: 'interval', every: '1m' },
	})
	expect(paidCreated.schedule).toEqual({ type: 'interval', every: '1m' })
})

test('syncPackageJobsForPackage enforces scheduled job entitlements for plan users and denies at the max plan ceiling', async () => {
	const plannedEmail = 'planned@example.com'
	const plannedUserId = testStableUserIdFromEmail(plannedEmail)
	const maxEmail = 'max@example.com'
	const maxUserId = testStableUserIdFromEmail(maxEmail)
	mockBackgroundEmails({
		[plannedUserId]: plannedEmail,
		[maxUserId]: maxEmail,
	})
	const trySync = (env: Env, userId: string, packageId: string) =>
		syncQuotaJob({ env, userId, packageId }).catch((caught: unknown) => caught)
	const plannedEnv = createJobServiceTestEnv({
		APP_DB: createDatabase({
			users: [
				{ email: plannedEmail, plan: 'free', stable_user_id: plannedUserId },
			],
		}),
	})
	const plannedCallerContext = createPlanUserCallerContext({
		userId: plannedUserId,
		email: plannedEmail,
	})
	const freeLimit = planLimits.free.maxScheduledJobs
	for (let index = 0; index < freeLimit; index += 1) {
		await insertPackageJob({
			env: plannedEnv,
			callerContext: plannedCallerContext,
			body: {
				name: `quota-job-${index}`,
				schedule: { type: 'interval', every: '15m' },
			},
		})
	}

	expectScheduledJobLimit(
		await trySync(plannedEnv, plannedUserId, 'free-quota-package'),
		{ plan: 'free', limit: freeLimit, current: freeLimit },
	)

	const maxEnvWithJobs = (count: number, prefix: string) =>
		createJobServiceTestEnv({
			APP_DB: createDatabase({
				users: [{ email: maxEmail, plan: 'max', stable_user_id: maxUserId }],
				jobs: Array.from({ length: count }, (_, index) => ({
					id: `${prefix}-${index}`,
					user_id: maxUserId,
					schedule_json: JSON.stringify({
						type: 'interval',
						every: '1h',
					}),
				})),
			}),
		})
	const belowMaxJob = await trySync(
		maxEnvWithJobs(planLimits.pro.maxScheduledJobs, 'below-max-job'),
		maxUserId,
		'below-max-package',
	)
	expect(isEntitlementLimitError(belowMaxJob)).toBe(false)
	expect(belowMaxJob).toMatchObject({ name: 'quota-job' })

	const maxLimit = planLimits.max.maxScheduledJobs
	expectScheduledJobLimit(
		await trySync(
			maxEnvWithJobs(maxLimit, 'max-job'),
			maxUserId,
			'max-quota-package',
		),
		{ plan: 'max', limit: maxLimit, current: maxLimit },
	)
})

test('blank-email package context uses the max plan for nested job scheduling', async () => {
	const email = 'package-owner@example.com'
	const userId = testStableUserIdFromEmail(email)
	const meter = createInMemoryUserMeterEnv()
	const db = createDatabase({
		users: [{ email, plan: 'max', stable_user_id: userId }],
		jobs: Array.from(
			{ length: planLimits.free.maxScheduledJobs },
			(_, index) => ({
				id: `existing-job-${index}`,
				user_id: userId,
				schedule_json: JSON.stringify({ type: 'interval', every: '1h' }),
			}),
		),
	})
	const env = createJobServiceTestEnv({ APP_DB: db }, meter)
	mockRepoPersistence()
	identityMockModule.resolveBackgroundMcpUser.mockResolvedValueOnce({
		userId: personIdFromStored(userId),
		email,
		username: userId,
		displayName: 'Package Owner',
	})
	await expect(
		syncQuotaJob({ env, userId, packageId: 'nested-schedule-package' }),
	).resolves.toMatchObject({ name: 'quota-job' })
})
