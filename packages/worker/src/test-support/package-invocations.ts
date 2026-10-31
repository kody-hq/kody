import { personIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import { createPackageEventTools } from '#worker/package-invocations/service.ts'
import type * as packageSourceModule from '#worker/package-registry/source.ts'
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'

export const packageInvocationsRepoMockModule = (() => {
	const loadPackageManifestBySourceId = vi.fn()
	return {
		getSavedPackageById: vi.fn(),
		resolveSavedPackageRef: vi.fn(),
		getSavedPackageByName: vi.fn(),
		listSavedPackagesByUserId: vi.fn(),
		loadPackageManifestBySourceId,
		// The invoke path loads the source row and manifest separately (see
		// loadInvokeManifestBySourceId); default to the same per-test data the
		// combined mock is configured with.
		loadPackageSourceRowForUser: vi.fn<
			typeof packageSourceModule.loadPackageSourceRowForUser
		>(async (input) => (await loadPackageManifestBySourceId(input)).source),
		loadPackageManifestForSource: vi.fn<
			typeof packageSourceModule.loadPackageManifestForSource
		>(
			async (input) =>
				await loadPackageManifestBySourceId({
					...input,
					sourceId: input.source.id,
				}),
		),
		loadPackageSourceRowsForUser: vi.fn<
			typeof packageSourceModule.loadPackageSourceRowsForUser
		>(async (input) => {
			// Stub rows for every requested id so subscription discovery can
			// exercise loadPackageManifestForSource (and any per-source
			// reject wired onto loadPackageManifestBySourceId) without a D1
			// prefetch. Real missing-source behavior is covered by the
			// admin-package-subscriptions node test against sqlite.
			const byId = new Map<
				string,
				Awaited<
					ReturnType<typeof packageSourceModule.loadPackageSourceRowForUser>
				>
			>()
			for (const sourceId of [...new Set(input.sourceIds)]) {
				byId.set(sourceId, {
					id: sourceId,
					user_id: input.userId,
					entity_kind: 'package',
					entity_id: `package-${sourceId}`,
					repo_id: `repo-${sourceId}`,
					published_commit: 'commit-1',
					indexed_commit: null,
					manifest_path: 'package.json',
					source_root: '/',
					last_external_check_at: null,
					external_check_until: null,
					created_at: '2026-01-01T00:00:00.000Z',
					updated_at: '2026-01-01T00:00:00.000Z',
				} as never)
			}
			return byId
		}),
		loadPackageSourceBySourceId: vi.fn(),
		getEntitySourceById: vi.fn(),
		loadPublishedBundleArtifactByIdentity: vi.fn(),
		persistPublishedBundleArtifact: vi.fn(),
		runBundledModuleWithRegistry: vi.fn(),
		recordAgentPackageConversationUse: vi.fn(),
		dispatchRunErrorSubscriptionEvents: vi.fn(),
	}
})()

export type FakeLedgerRow = {
	id: string
	tokenId: string
	packageId: string
	packageKodyId: string
	exportName: string
	idempotencyKey: string
	requestHash: string
	source: string | null
	topic: string | null
	claimOwner: string | null
	status: 'in_progress' | 'completed' | 'failed'
	responseJson: string | null
	createdAt: string
	updatedAt: string
}

/**
 * In-memory stand-in for the RunLog Durable Object's package-invocation
 * ledger RPCs (the real DO semantics are covered by
 * run-records/invocation-ledger.workers.test.ts against the actual binding).
 */
export function createFakeRunLog(
	options: { failClaim?: boolean; failFinish?: boolean } = {},
) {
	const ledgerRows: Array<FakeLedgerRow> = []
	const runRows = new Map<string, Record<string, unknown>>()
	const jobObservability = new Map<
		string,
		{
			jobId: string
			lastRunAt: string | null
			lastRunStatus: 'success' | 'error' | null
			lastRunError: string | null
			lastDurationMs: number | null
			runCount: number
			successCount: number
			errorCount: number
			updatedAt: string
		}
	>()
	const packageRunSuccesses = new Map<
		string,
		{ packageId: string; successCount: number; updatedAt: string }
	>()
	const activationMilestones = new Map<
		string,
		{ milestone: string; reachedAt: string; packageId: string | null }
	>()
	const runLogs = new Map<string, Array<string>>()
	const clone = <T>(value: T): T => structuredClone(value)
	const logMessage = (entry: unknown) => {
		if (typeof entry === 'string') return entry
		if (entry && typeof entry === 'object' && 'message' in entry) {
			return String((entry as { message: unknown }).message)
		}
		return String(entry)
	}
	const findByKey = (key: {
		tokenId: string
		packageId: string
		exportName: string
		idempotencyKey: string
	}) =>
		ledgerRows.find(
			(row) =>
				row.tokenId === key.tokenId &&
				row.packageId === key.packageId &&
				row.exportName === key.exportName &&
				row.idempotencyKey === key.idempotencyKey,
		) ?? null
	const rpc = {
		async claimPackageInvocation(input: {
			invocation: Omit<
				FakeLedgerRow,
				'status' | 'responseJson' | 'createdAt' | 'updatedAt' | 'claimOwner'
			> & { claimOwner?: string | null }
			staleBefore: string
			sameOwnerStaleBefore?: string
			run: Record<string, unknown> | null
			initialLogs?: Array<unknown>
		}) {
			if (options.failClaim) throw new Error('RunLog unavailable')
			const now = new Date().toISOString()
			const claimOwner =
				typeof input.invocation.claimOwner === 'string' &&
				input.invocation.claimOwner.trim().length > 0
					? input.invocation.claimOwner.trim()
					: null
			const existing = findByKey(input.invocation)
			if (existing) {
				const sameOwnerReclaim =
					claimOwner != null &&
					existing.claimOwner != null &&
					existing.claimOwner === claimOwner &&
					input.sameOwnerStaleBefore != null &&
					existing.updatedAt <= input.sameOwnerStaleBefore
				const reclaimable =
					existing.status === 'in_progress' &&
					existing.responseJson == null &&
					existing.requestHash === input.invocation.requestHash &&
					(existing.updatedAt <= input.staleBefore || sameOwnerReclaim)
				if (!reclaimable) {
					return { outcome: 'existing' as const, record: clone(existing) }
				}
				existing.updatedAt = now
				existing.claimOwner = claimOwner
				if (input.run) {
					const runId = String(input.run['id'])
					runRows.set(runId, clone({ ...input.run, invocationId: existing.id }))
					runLogs.set(runId, (input.initialLogs ?? []).map(logMessage))
				}
				return {
					outcome: 'claimed' as const,
					invocationId: existing.id,
					claimUpdatedAt: now,
					reclaimed: true,
				}
			}
			ledgerRows.push({
				...clone(input.invocation),
				claimOwner,
				status: 'in_progress',
				responseJson: null,
				createdAt: now,
				updatedAt: now,
			})
			if (input.run) {
				const runId = String(input.run['id'])
				runRows.set(
					runId,
					clone({ ...input.run, invocationId: input.invocation.id }),
				)
				runLogs.set(runId, (input.initialLogs ?? []).map(logMessage))
			}
			return {
				outcome: 'claimed' as const,
				invocationId: input.invocation.id,
				claimUpdatedAt: now,
				reclaimed: false,
			}
		},
		async getPackageInvocation(key: {
			tokenId: string
			packageId: string
			exportName: string
			idempotencyKey: string
		}) {
			const row = findByKey(key)
			return row ? clone(row) : null
		},
		async finishPackageInvocation(input: {
			invocationId: string
			claimUpdatedAt: string
			status: 'completed' | 'failed'
			responseJson: string | null
			run: Record<string, unknown> | null
			logs: Array<unknown>
		}) {
			if (options.failFinish) throw new Error('RunLog finish unavailable')
			const row =
				ledgerRows.find((candidate) => candidate.id === input.invocationId) ??
				null
			let ledgerUpdated = false
			if (
				row &&
				row.status === 'in_progress' &&
				row.updatedAt === input.claimUpdatedAt
			) {
				row.status = input.status
				row.responseJson = input.responseJson
				row.updatedAt = new Date().toISOString()
				ledgerUpdated = true
			}
			if (input.run) {
				const runId = String(input.run['id'])
				runLogs.set(runId, input.logs.map(logMessage))
				const previous = runRows.get(runId)
				const previousStatus =
					previous && typeof previous['status'] === 'string'
						? String(previous['status'])
						: null
				runRows.set(String(input.run['id']), clone(input.run))
				// Mirror RunLog terminal side effects used by finish seeding:
				// activation increments and job observability for genuine new
				// terminal writes (replay of an already-terminal row is a no-op).
				const runStatus = String(input.run['status'] ?? '')
				const alreadyTerminal =
					previousStatus === 'success' || previousStatus === 'error'
				if (!alreadyTerminal && runStatus === 'success') {
					const packageId =
						typeof input.run['packageId'] === 'string'
							? input.run['packageId'].trim()
							: ''
					const surface =
						typeof input.run['surface'] === 'string'
							? input.run['surface']
							: null
					// Match RunLog: once global package_activated exists, counters
					// stop changing for every package.
					if (
						packageId &&
						surface !== 'webhook' &&
						surface !== 'app_fetch' &&
						!activationMilestones.has('package_activated')
					) {
						const reachedAt =
							typeof input.run['finishedAt'] === 'string'
								? input.run['finishedAt']
								: new Date().toISOString()
						const existing = packageRunSuccesses.get(packageId)
						const successCount = (existing?.successCount ?? 0) + 1
						packageRunSuccesses.set(packageId, {
							packageId,
							successCount,
							updatedAt: reachedAt,
						})
						if (!activationMilestones.has('package_run_succeeded')) {
							activationMilestones.set('package_run_succeeded', {
								milestone: 'package_run_succeeded',
								reachedAt,
								packageId,
							})
						}
						if (successCount >= 2) {
							activationMilestones.set('package_activated', {
								milestone: 'package_activated',
								reachedAt,
								packageId,
							})
						}
					}
				}
				if (
					!alreadyTerminal &&
					(runStatus === 'success' || runStatus === 'error')
				) {
					const jobId =
						typeof input.run['jobId'] === 'string'
							? input.run['jobId'].trim()
							: ''
					if (jobId) {
						const existing = jobObservability.get(jobId)
						const ranAt =
							typeof input.run['finishedAt'] === 'string'
								? input.run['finishedAt']
								: new Date().toISOString()
						const durationMs =
							typeof input.run['durationMs'] === 'number'
								? input.run['durationMs']
								: null
						const error =
							runStatus === 'error' &&
							typeof input.run['errorMessage'] === 'string'
								? input.run['errorMessage']
								: null
						jobObservability.set(jobId, {
							jobId,
							lastRunAt: ranAt,
							lastRunStatus: runStatus,
							lastRunError: error,
							lastDurationMs: durationMs,
							runCount: (existing?.runCount ?? 0) + 1,
							successCount:
								(existing?.successCount ?? 0) +
								(runStatus === 'success' ? 1 : 0),
							errorCount:
								(existing?.errorCount ?? 0) + (runStatus === 'error' ? 1 : 0),
							updatedAt: ranAt,
						})
					}
				}
			}
			return {
				ledgerUpdated,
				record: ledgerUpdated ? null : row ? clone(row) : null,
			}
		},
		async stagePackageInvocationResult(input: {
			invocationId: string
			claimUpdatedAt: string
			responseJson: string | null
			run: Record<string, unknown> | null
			logs: Array<unknown>
		}) {
			const row =
				ledgerRows.find((candidate) => candidate.id === input.invocationId) ??
				null
			if (
				!row ||
				row.status !== 'in_progress' ||
				row.updatedAt !== input.claimUpdatedAt
			) {
				return {
					staged: false,
					claimUpdatedAt: null,
					record: row ? clone(row) : null,
				}
			}
			const now = new Date().toISOString()
			row.responseJson = input.responseJson
			row.updatedAt = now
			if (input.run) {
				const runId = String(input.run['id'])
				runLogs.set(runId, input.logs.map(logMessage))
				runRows.set(runId, clone(input.run))
			}
			return { staged: true, claimUpdatedAt: now, record: null }
		},
		async touchPackageInvocation(input: {
			invocationId: string
			claimUpdatedAt: string
		}) {
			const row =
				ledgerRows.find((candidate) => candidate.id === input.invocationId) ??
				null
			if (
				!row ||
				row.status !== 'in_progress' ||
				row.updatedAt !== input.claimUpdatedAt
			) {
				return {
					touched: false,
					claimUpdatedAt: null,
					record: row ? clone(row) : null,
				}
			}
			const now = new Date().toISOString()
			row.updatedAt = now
			return { touched: true, claimUpdatedAt: now, record: null }
		},
		async releasePackageInvocation(input: {
			invocationId: string
			claimUpdatedAt: string
			runId: string | null
			run: Record<string, unknown> | null
			logs: Array<unknown>
		}) {
			const index = ledgerRows.findIndex(
				(candidate) => candidate.id === input.invocationId,
			)
			const row = index >= 0 ? ledgerRows[index] : null
			let released = false
			if (
				row &&
				row.status === 'in_progress' &&
				row.updatedAt === input.claimUpdatedAt
			) {
				ledgerRows.splice(index, 1)
				released = true
			}
			let runFinished = false
			if (input.run) {
				const runId = String(input.run['id'])
				const previous = runRows.get(runId)
				const previousStatus =
					previous && typeof previous['status'] === 'string'
						? String(previous['status'])
						: null
				if (previousStatus === 'running' || previousStatus == null) {
					runRows.set(runId, clone(input.run))
					runLogs.set(runId, input.logs.map(logMessage))
					runFinished = true
				}
			} else if (input.runId) {
				const run = runRows.get(input.runId)
				if (run && run['status'] === 'running') {
					runRows.delete(input.runId)
				}
			}
			return {
				released,
				record: released || !row ? null : clone(row),
				runFinished,
			}
		},
		async getJobRunObservability(input: { jobId: string }) {
			const row = jobObservability.get(input.jobId)
			return row ? clone(row) : null
		},
	}
	return {
		namespace: {
			idFromName: (name: string) => name as unknown as DurableObjectId,
			get: () => rpc,
		},
		ledgerRows,
		runRows,
		runLogs,
		corruptStoredResponses() {
			for (const row of ledgerRows) {
				row.responseJson = '{"status":200,"body":null}'
			}
		},
		seedStaleInvocation(idempotencyKey: string) {
			const completed = ledgerRows[0]
			if (!completed) throw new Error('Expected completed invocation seed.')
			const row: FakeLedgerRow = {
				...structuredClone(completed),
				id: crypto.randomUUID(),
				idempotencyKey,
				claimOwner: null,
				status: 'in_progress',
				responseJson: null,
				createdAt: '2026-01-01T00:00:00.000Z',
				updatedAt: '2026-01-01T00:00:00.000Z',
			}
			ledgerRows.push(row)
			return structuredClone(row)
		},
		seedFreshInvocation(
			idempotencyKey: string,
			claimOwner: string | null = null,
		) {
			const completed = ledgerRows[0]
			if (!completed) throw new Error('Expected completed invocation seed.')
			const now = new Date().toISOString()
			ledgerRows.push({
				...structuredClone(completed),
				id: crypto.randomUUID(),
				idempotencyKey,
				claimOwner,
				status: 'in_progress',
				responseJson: null,
				createdAt: now,
				updatedAt: now,
			})
		},
		completeInvocation(idempotencyKey: string) {
			const row = ledgerRows.find(
				(candidate) => candidate.idempotencyKey === idempotencyKey,
			)
			const completed = ledgerRows[0]
			if (!row || !completed) throw new Error('Expected invocation rows.')
			row.status = 'completed'
			row.responseJson = completed.responseJson
			row.updatedAt = new Date().toISOString()
		},
		/** Mutable so tests can recover finish after a staged persist failure. */
		options,
	}
}

/**
 * Fake D1 that rejects EVERY `package_invocations` statement (the table is
 * dropped; the ledger lives in the RunLog DO) and every write. Keyed tests
 * passing against this is the proof that no D1 ledger read or write remains
 * anywhere on the invoke path.
 */
export function createDatabase(
	options: { failClaim?: boolean; failFinish?: boolean } = {},
) {
	const runLog = createFakeRunLog(options)
	const db = {
		prepare(query: string) {
			if (query.includes('package_invocations')) {
				throw new Error(
					`Unexpected D1 access to the dropped package_invocations table: ${query}`,
				)
			}
			return {
				bind() {
					return {
						async first<T = Record<string, unknown>>() {
							return null as T | null
						},
						async all<T = Record<string, unknown>>() {
							return { results: [] as Array<T>, success: true }
						},
						async run() {
							throw new Error(
								`Unexpected D1 write on the keyed invocation path: ${query}`,
							)
						},
					}
				},
			}
		},
		runLog,
	} as unknown as D1Database & {
		runLog: ReturnType<typeof createFakeRunLog>
	}
	return db
}

export function createEnv(
	db: ReturnType<typeof createDatabase>,
	overrides: Record<string, unknown> = {},
) {
	const meter =
		overrides['USER_METER'] == null ? createInMemoryUserMeterEnv() : null
	return {
		APP_DB: db,
		RUN_LOG: db.runLog.namespace,
		BUNDLE_ARTIFACTS_KV: {
			get: async () => null,
			put: async () => undefined,
			delete: async () => undefined,
		},
		...(meter ? { USER_METER: meter.env.USER_METER } : {}),
		...overrides,
	} as unknown as Env
}

/**
 * Env plus the in-memory UserMeter harness so tests can seed daily counters.
 */
export function createEnvWithUserMeter(
	db: ReturnType<typeof createDatabase>,
	overrides: Record<string, unknown> = {},
) {
	const meter = createInMemoryUserMeterEnv()
	return {
		env: createEnv(db, {
			USER_METER: meter.env.USER_METER,
			...overrides,
		}),
		meter,
	}
}

/** In-memory synthetic invoke scope for tests (not a D1 token row). */
export function createToken(
	overrides: Partial<{
		packageId: string
		exportNames: Array<string>
	}> = {},
) {
	return {
		tokenId: 'discord-gateway',
		userId: 'user-123',
		email: 'me@example.com',
		packageId: overrides.packageId ?? 'pkg-1',
		exportNames: overrides.exportNames ?? ['./dispatch-message-created'],
		request: { kind: 'webhook', sourceId: 'discord-gateway' },
	} as const
}

export function seedPackageResolution(
	input: {
		packageId?: string
		name?: string
		kodyId?: string
		description?: string
		exportName?: string
		entryPoint?: string
	} = {},
) {
	const packageId = input.packageId ?? 'pkg-1'
	const name = input.name ?? '@kentcdodds/discord-gateway'
	const kodyId = input.kodyId ?? 'discord-gateway'
	const description = input.description ?? 'Discord gateway helpers'
	const exportName = input.exportName ?? './dispatch-message-created'
	const entryPoint = input.entryPoint ?? 'src/dispatch-message-created.ts'
	packageInvocationsRepoMockModule.getSavedPackageById.mockResolvedValue(null)
	packageInvocationsRepoMockModule.resolveSavedPackageRef.mockResolvedValue({
		id: packageId,
		userId: 'user-123',
		name,
		kodyId,
		description,
		tags: [],
		searchText: null,
		sourceId: 'source-1',
		hasApp: true,
		hidden: false,
		isPrivate: false,
		isInternetVisible: false,
		createdAt: '2026-04-27T00:00:00.000Z',
		updatedAt: '2026-04-27T00:00:00.000Z',
	})
	packageInvocationsRepoMockModule.loadPackageManifestBySourceId.mockResolvedValue(
		{
			source: {
				id: 'source-1',
				user_id: 'user-123',
				entity_kind: 'package',
				entity_id: packageId,
				repo_id: 'repo-1',
				published_commit: 'commit-1',
				indexed_commit: null,
				manifest_path: 'package.json',
				source_root: '/',
				created_at: '2026-04-27T00:00:00.000Z',
				updated_at: '2026-04-27T00:00:00.000Z',
			},
			manifest: {
				name,
				exports: {
					[exportName]: `./${entryPoint}`,
				},
				kody: {
					id: kodyId,
					description,
					app: {
						entry: './src/app.ts',
					},
				},
			},
		},
	)
	packageInvocationsRepoMockModule.loadPackageSourceBySourceId.mockResolvedValue(
		{
			source: {
				id: 'source-1',
				user_id: 'user-123',
				entity_kind: 'package',
				entity_id: packageId,
				repo_id: 'repo-1',
				published_commit: 'commit-1',
				indexed_commit: null,
				manifest_path: 'package.json',
				source_root: '/',
				created_at: '2026-04-27T00:00:00.000Z',
				updated_at: '2026-04-27T00:00:00.000Z',
			},
			manifest: {
				name,
				exports: {
					[exportName]: `./${entryPoint}`,
				},
				kody: {
					id: kodyId,
					description,
					app: {
						entry: './src/app.ts',
					},
				},
			},
			files: {
				'package.json': JSON.stringify({
					name,
					exports: {
						[exportName]: `./${entryPoint}`,
					},
					kody: {
						id: kodyId,
						description,
						app: {
							entry: './src/app.ts',
						},
					},
				}),
				[entryPoint]:
					'export default async function run(){ return { ok: true } }',
			},
		},
	)
	packageInvocationsRepoMockModule.getEntitySourceById.mockResolvedValue({
		id: 'source-1',
		user_id: 'user-123',
		entity_kind: 'package',
		entity_id: packageId,
		repo_id: 'repo-1',
		published_commit: 'commit-1',
		indexed_commit: null,
		manifest_path: 'package.json',
		source_root: '/',
		created_at: '2026-04-27T00:00:00.000Z',
		updated_at: '2026-04-27T00:00:00.000Z',
	})
	packageInvocationsRepoMockModule.loadPublishedBundleArtifactByIdentity.mockResolvedValue(
		{
			row: {
				id: 'artifact-1',
				publishedCommit: 'commit-1',
			},
			artifact: {
				version: 1,
				kind: 'module',
				artifactName: exportName,
				sourceId: 'source-1',
				publishedCommit: 'commit-1',
				entryPoint,
				mainModule: 'dist/index.js',
				modules: {
					'dist/index.js':
						'export default async function run(){ return { ok: true } }',
				},
				dependencies: [],
				packageContext: {
					packageId,
					kodyId,
					sourceId: 'source-1',
				},
				createdAt: '2026-04-27T00:00:00.000Z',
			},
		},
	)
	packageInvocationsRepoMockModule.persistPublishedBundleArtifact.mockResolvedValue(
		'kv:key',
	)
}

export function createSavedPackage(input: {
	id: string
	sourceId: string
	name: string
	kodyId: string
	description?: string
}) {
	return {
		id: input.id,
		userId: 'user-123',
		name: input.name,
		kodyId: input.kodyId,
		description: input.description ?? `${input.kodyId} package`,
		tags: [],
		searchText: null,
		sourceId: input.sourceId,
		hasApp: false,
		hidden: false,
		isPrivate: false,
		isInternetVisible: false,
		createdAt: '2026-05-10T00:00:00.000Z',
		updatedAt: '2026-05-10T00:00:00.000Z',
	}
}

export function createSource(input: {
	id: string
	entityId: string
	commit: string
}) {
	return {
		id: input.id,
		user_id: 'user-123',
		entity_kind: 'package',
		entity_id: input.entityId,
		repo_id: `repo-${input.id}`,
		published_commit: input.commit,
		indexed_commit: null,
		manifest_path: 'package.json',
		source_root: '/',
		created_at: '2026-05-10T00:00:00.000Z',
		updated_at: '2026-05-10T00:00:00.000Z',
	}
}

export function createManifest(input: {
	name: string
	kodyId: string
	exportName: string
	entryPoint: string
	emits?: Record<
		string,
		{ description: string; payloadSchema?: Record<string, unknown> }
	>
	subscriptions?: Record<
		string,
		{
			handler: string
			description?: string
			filters?: Record<string, unknown>
		}
	>
}) {
	return {
		name: input.name,
		exports: {
			[input.exportName]: input.entryPoint,
		},
		kody: {
			id: input.kodyId,
			description: `${input.kodyId} package`,
			emits: input.emits,
			subscriptions: input.subscriptions,
		},
	}
}

export function createModuleArtifact(input: {
	sourceId: string
	publishedCommit: string
	artifactName: string
	entryPoint: string
	mainModule: string
	packageContext: {
		packageId: string
		kodyId: string
		sourceId: string
	}
}) {
	return {
		row: {
			id: `artifact-${input.packageContext.packageId}`,
			publishedCommit: input.publishedCommit,
		},
		artifact: {
			version: 1,
			kind: 'module',
			artifactName: input.artifactName,
			sourceId: input.sourceId,
			publishedCommit: input.publishedCommit,
			entryPoint: input.entryPoint,
			mainModule: input.mainModule,
			modules: {
				[input.mainModule]:
					'export default async function run(){ return { ok: true } }',
			},
			dependencies: [],
			packageContext: input.packageContext,
			createdAt: '2026-05-10T00:00:00.000Z',
		},
	}
}

export function seedRuntimeDispatchPackages() {
	const gateway = createSavedPackage({
		id: 'pkg-gateway',
		sourceId: 'source-gateway',
		name: '@kentcdodds/discord-gateway',
		kodyId: 'discord-gateway',
	})
	const subscriber = createSavedPackage({
		id: 'pkg-subscriber',
		sourceId: 'source-subscriber',
		name: '@kentcdodds/discord-general-chat',
		kodyId: 'discord-general-chat',
	})
	const sources = new Map([
		[
			'source-gateway',
			createSource({
				id: 'source-gateway',
				entityId: 'pkg-gateway',
				commit: 'gateway-commit-1',
			}),
		],
		[
			'source-subscriber',
			createSource({
				id: 'source-subscriber',
				entityId: 'pkg-subscriber',
				commit: 'subscriber-commit-1',
			}),
		],
	])
	const manifests = new Map([
		[
			'source-gateway',
			createManifest({
				name: gateway.name,
				kodyId: gateway.kodyId,
				exportName: './dispatch-message-created',
				entryPoint: './src/dispatch-message-created.ts',
				emits: {
					'@kentcdodds/discord.message.created': {
						description: 'A Discord message was created.',
					},
				},
			}),
		],
		[
			'source-subscriber',
			createManifest({
				name: subscriber.name,
				kodyId: subscriber.kodyId,
				exportName: './handle-discord-message-created',
				entryPoint: './src/handle-discord-message-created.ts',
				subscriptions: {
					'@kentcdodds/discord.message.created': {
						handler: './src/handle-discord-message-created.ts',
						description: 'Handle Discord message events.',
					},
				},
			}),
		],
	])
	const sourceFiles = new Map([
		[
			'source-gateway',
			{
				'package.json': JSON.stringify(manifests.get('source-gateway')),
				'src/dispatch-message-created.ts':
					'export default async function dispatchMessageCreated(input: Record<string, unknown>) { return input }',
			},
		],
		[
			'source-subscriber',
			{
				'package.json': JSON.stringify(manifests.get('source-subscriber')),
				'src/handle-discord-message-created.ts': `/**
 * Handle a Discord message-created event.
 */
export default async function handleDiscordMessageCreated(input: { event: { id: string }, dryRun?: boolean }): Promise<{ handled: boolean }> {
	return { handled: true }
}`,
			},
		],
	])
	packageInvocationsRepoMockModule.getSavedPackageById.mockResolvedValue(null)
	packageInvocationsRepoMockModule.resolveSavedPackageRef.mockImplementation(
		async (_db: unknown, input: { userId: string; ref: string }) => {
			expect(input.userId).toBe('user-123')
			if (input.ref === gateway.kodyId) return gateway
			if (input.ref === subscriber.kodyId) return subscriber
			return null
		},
	)
	packageInvocationsRepoMockModule.getSavedPackageByName.mockImplementation(
		async (_db: unknown, input: { userId: string; name: string }) => {
			expect(input.userId).toBe('user-123')
			if (input.name === gateway.name) return gateway
			if (input.name === subscriber.name) return subscriber
			return null
		},
	)
	packageInvocationsRepoMockModule.listSavedPackagesByUserId.mockImplementation(
		async (_db: unknown, input: { userId: string }) => {
			expect(input.userId).toBe('user-123')
			return [gateway, subscriber]
		},
	)
	packageInvocationsRepoMockModule.loadPackageManifestBySourceId.mockImplementation(
		async (input: { sourceId: string }) => ({
			source: sources.get(input.sourceId),
			manifest: manifests.get(input.sourceId),
		}),
	)
	packageInvocationsRepoMockModule.loadPackageSourceBySourceId.mockImplementation(
		async (input: { sourceId: string }) => ({
			source: sources.get(input.sourceId),
			manifest: manifests.get(input.sourceId),
			files: sourceFiles.get(input.sourceId) ?? {},
		}),
	)
	packageInvocationsRepoMockModule.getEntitySourceById.mockImplementation(
		async (_db: unknown, sourceId: string) => sources.get(sourceId) ?? null,
	)
	packageInvocationsRepoMockModule.loadPublishedBundleArtifactByIdentity.mockImplementation(
		async (input: {
			sourceId: string
			artifactName: string
			entryPoint: string
		}) => {
			if (input.sourceId === 'source-gateway') {
				return createModuleArtifact({
					sourceId: 'source-gateway',
					publishedCommit: 'gateway-commit-1',
					artifactName: './dispatch-message-created',
					entryPoint: 'src/dispatch-message-created.ts',
					mainModule: 'dist/gateway.js',
					packageContext: {
						packageId: gateway.id,
						kodyId: gateway.kodyId,
						sourceId: gateway.sourceId,
					},
				})
			}
			if (input.sourceId === 'source-subscriber') {
				return createModuleArtifact({
					sourceId: 'source-subscriber',
					publishedCommit: 'subscriber-commit-1',
					artifactName:
						input.artifactName ===
						'subscription:@kentcdodds/discord.message.created'
							? 'subscription:@kentcdodds/discord.message.created'
							: './handle-discord-message-created',
					entryPoint: 'src/handle-discord-message-created.ts',
					mainModule: 'dist/subscriber.js',
					packageContext: {
						packageId: subscriber.id,
						kodyId: subscriber.kodyId,
						sourceId: subscriber.sourceId,
					},
				})
			}
			return null
		},
	)
	return { gateway, manifests, sourceFiles, sources, subscriber }
}

export function createRuntimeEventTools(
	db: ReturnType<typeof createDatabase>,
	options: {
		envOverrides?: Record<string, unknown>
		packageInvokeDepth?: number
		/**
		 * When set, the caller is bound to this org (team-org regression).
		 * Omit for the default personal-org caller.
		 */
		orgBinding?: Parameters<typeof createMcpCallerContext>[0]['orgBinding']
	} = {},
) {
	return createPackageEventTools({
		env: {
			...(createEnv(db) as unknown as Record<string, unknown>),
			...options.envOverrides,
		} as unknown as Env,
		baseUrl: 'https://kody.dev',
		callerContext: createMcpCallerContext({
			source: { kind: 'mcp-oauth' },
			baseUrl: 'https://kody.dev',
			user: {
				userId: personIdFromStored('user-123'),
				email: 'me@example.com',
				displayName: 'Me',
			},
			...(options.orgBinding ? { orgBinding: options.orgBinding } : {}),
		}),
		packageContext: {
			packageId: 'pkg-gateway',
			kodyId: 'discord-gateway',
			sourceId: 'source-gateway',
		},
		parentRunRecord: {
			packageId: 'pkg-gateway',
			kodyId: 'discord-gateway',
			sourceId: 'source-gateway',
			surface: 'export',
			name: './dispatch-message-created',
			idempotencyKey: 'message-1',
		},
		packageInvokeDepth: options.packageInvokeDepth ?? 0,
	})
}
