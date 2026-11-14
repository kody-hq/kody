import { utcDayKey } from '@kody-internal/shared/date-keys.ts'
import { writeLeaseTtlMs } from '#worker/account/write-lease-timing.ts'
import {
	admitExecuteCallInWindows,
	ExecuteRepeatWindow,
	type ExecuteCallMinuteWindow,
	type ExecuteRepeatInput,
} from '#worker/entitlements/execute-admission-windows.ts'
import {
	isDailyEntitlementResource,
	type DailyEntitlementResource,
} from '#universal/plans.ts'
import {
	userMeterDailyCounterRetentionDays,
	userMeterMirrorUpdatedAtToken,
	type UserMeterDailyTrendCounterRow,
	type UserMeterDailyTrendUniqueWorkerDayRow,
	type UserMeterDeletionStateExport,
	type UserMeterStorageBytesState,
	type UserMeterWriteLeaseEntry,
} from '#worker/entitlements/user-meter-do.ts'

type MeterRow = { count: number; revision: number }
type StorageRow = { bytes: number; revision: number; updatedAt: string }
type WriteLeaseRow = {
	holder: string
	acquiredAt: string
	pendingRepairId: string | null
	expiresAtMs: number
}
type DeletionState = {
	deletingAt: string | null
	leases: Map<string, WriteLeaseRow>
}

/**
 * In-memory UserMeter stub keyed by `idFromName` (stable userId) for node-unit
 * coverage of authoritative usage paths. Workers suites exercise the real
 * Durable Object binding instead.
 */
export function createInMemoryUserMeterEnv() {
	const metersByUser = new Map<string, Map<string, MeterRow>>()
	const storageByUser = new Map<string, StorageRow>()
	const deletionByUser = new Map<string, DeletionState>()
	const dynamicWorkerDaysByUser = new Map<string, Set<string>>()
	const lastUsedByUser = new Map<string, Map<string, string>>()
	const executeAdmissionByUser = new Map<
		string,
		{ minuteWindow: ExecuteCallMinuteWindow; repeatWindow: ExecuteRepeatWindow }
	>()
	const executeCallDaysByUser = new Map<string, Map<string, number>>()
	function counterKey(resource: string, day: string) {
		return `${resource}\0${day}`
	}

	function deletionStateFor(userId: string): DeletionState {
		const existing = deletionByUser.get(userId)
		if (existing) return existing
		const created: DeletionState = {
			deletingAt: null,
			leases: new Map(),
		}
		deletionByUser.set(userId, created)
		return created
	}

	function meterFor(userId: string) {
		const existingRows = metersByUser.get(userId)
		const rows = existingRows ?? new Map<string, MeterRow>()
		if (!existingRows) metersByUser.set(userId, rows)

		const deletion = deletionStateFor(userId)
		// Mirrors UserMeter: once a deletion is fencing, a lapsed lease is gone.
		const dropLapsedLeasesWhileDeleting = () => {
			if (deletion.deletingAt == null) return
			for (const [token, lease] of deletion.leases) {
				if (lease.expiresAtMs <= Date.now()) deletion.leases.delete(token)
			}
		}
		const existingDynamicWorkerDays = dynamicWorkerDaysByUser.get(userId)
		const dynamicWorkerDays = existingDynamicWorkerDays ?? new Set<string>()
		if (!existingDynamicWorkerDays) {
			dynamicWorkerDaysByUser.set(userId, dynamicWorkerDays)
		}
		const existingLastUsed = lastUsedByUser.get(userId)
		const lastUsed = existingLastUsed ?? new Map<string, string>()
		if (!existingLastUsed) lastUsedByUser.set(userId, lastUsed)
		const existingExecuteCallDays = executeCallDaysByUser.get(userId)
		const executeCallDays = existingExecuteCallDays ?? new Map<string, number>()
		if (!existingExecuteCallDays) {
			executeCallDaysByUser.set(userId, executeCallDays)
		}

		function readRow(resource: string, day: string) {
			return rows.get(counterKey(resource, day)) ?? null
		}

		function sumRange(resource: string, startDay: string, endDay: string) {
			let total = 0
			for (const [entryKey, row] of rows) {
				const separator = entryKey.indexOf('\0')
				if (separator < 0) continue
				const rowResource = entryKey.slice(0, separator)
				const day = entryKey.slice(separator + 1)
				if (rowResource !== resource) continue
				if (day < startDay || day > endDay) continue
				total += row.count
			}
			return total
		}

		function ready(row: MeterRow) {
			return {
				outcome: 'ready' as const,
				count: row.count,
				revision: row.revision,
				mirrorUpdatedAt: userMeterMirrorUpdatedAtToken(row.revision),
			}
		}

		function storageReady(row: StorageRow) {
			return {
				outcome: 'ready' as const,
				bytes: row.bytes,
				revision: row.revision,
				mirrorUpdatedAt: userMeterMirrorUpdatedAtToken(row.revision),
			}
		}

		function writeLeaseState(
			token: string,
			row: WriteLeaseRow,
		): UserMeterWriteLeaseEntry {
			return {
				token,
				holder: row.holder,
				acquiredAt: row.acquiredAt,
			}
		}

		function listWriteLeasesSorted() {
			return [...deletion.leases.entries()]
				.map(([token, row]) => writeLeaseState(token, row))
				.sort((left, right) => {
					const byAcquired = left.acquiredAt.localeCompare(right.acquiredAt)
					if (byAcquired !== 0) return byAcquired
					return left.token.localeCompare(right.token)
				})
		}

		function pageWriteLeases(input: {
			pageSize?: number
			startAfter?: string | null
		}) {
			const pageSize =
				typeof input.pageSize === 'number' && Number.isFinite(input.pageSize)
					? Math.min(Math.max(Math.trunc(input.pageSize), 1), 500)
					: 100
			const all = listWriteLeasesSorted()
			let startIndex = 0
			if (typeof input.startAfter === 'string' && input.startAfter.length > 0) {
				try {
					const parsed = JSON.parse(input.startAfter) as unknown
					if (
						Array.isArray(parsed) &&
						parsed.length === 2 &&
						typeof parsed[0] === 'string' &&
						typeof parsed[1] === 'string'
					) {
						const acquiredAt = parsed[0]
						const token = parsed[1]
						startIndex =
							all.findIndex(
								(row) => row.acquiredAt === acquiredAt && row.token === token,
							) + 1
					}
				} catch {
					startIndex = 0
				}
			}
			const page = all.slice(startIndex, startIndex + pageSize)
			const truncated = startIndex + pageSize < all.length
			const last = page[page.length - 1]
			return {
				leases: page,
				nextStartAfter:
					truncated && last
						? JSON.stringify([last.acquiredAt, last.token])
						: null,
				truncated,
			}
		}

		function readDeletionStateExport(): UserMeterDeletionStateExport {
			const writeLeases = listWriteLeasesSorted().map((lease) => ({
				acquiredAt: lease.acquiredAt,
			}))
			return {
				deletingAt: deletion.deletingAt,
				activeWriteLeaseCount: writeLeases.length,
				writeLeases,
			}
		}

		async function consumeCounter(input: {
			resource: string
			day: string
			limit: number
			updatedAt: string
			weekStart?: string
			weekLimit?: number | null
		}) {
			if (!isDailyEntitlementResource(input.resource)) {
				throw new Error(`Invalid daily resource: ${input.resource}`)
			}
			const resource: DailyEntitlementResource = input.resource
			const existing = readRow(resource, input.day)
			if (!existing) return { outcome: 'needs_bootstrap' as const }
			const weekLimit =
				typeof input.weekLimit === 'number' && Number.isFinite(input.weekLimit)
					? input.weekLimit
					: null
			const weekStart = input.weekStart ?? null
			const weekCount =
				weekStart && weekLimit !== null
					? sumRange(resource, weekStart, input.day)
					: undefined
			if (input.limit < 1 || existing.count + 1 > input.limit) {
				return {
					...ready(existing),
					consumed: false,
					deniedWindow: 'day' as const,
					weekCount,
				}
			}
			if (
				weekStart &&
				weekLimit !== null &&
				(weekLimit < 1 || (weekCount ?? 0) + 1 > weekLimit)
			) {
				return {
					...ready(existing),
					consumed: false,
					deniedWindow: 'week' as const,
					weekCount,
				}
			}
			const next = {
				count: existing.count + 1,
				revision: existing.revision + 1,
			}
			rows.set(counterKey(resource, input.day), next)
			return {
				...ready(next),
				consumed: true,
				weekCount: weekCount === undefined ? undefined : weekCount + 1,
			}
		}

		return {
			async initialize(input: {
				resource: string
				day: string
				count: number
				updatedAt: string
			}) {
				if (!isDailyEntitlementResource(input.resource)) {
					throw new Error(`Invalid daily resource: ${input.resource}`)
				}
				const key = counterKey(input.resource, input.day)
				const existing = rows.get(key)
				if (existing) return { ...ready(existing), created: false }
				const row = {
					count: Math.max(0, Math.trunc(input.count) || 0),
					revision: 1,
				}
				rows.set(key, row)
				return { ...ready(row), created: true }
			},
			async consume(input: {
				resource: string
				day: string
				limit: number
				updatedAt: string
				weekStart?: string
				weekLimit?: number | null
			}) {
				return await consumeCounter(input)
			},
			async read(input: { resource: string; day: string }) {
				const existing = readRow(input.resource, input.day)
				if (!existing) return { outcome: 'needs_bootstrap' as const }
				return ready(existing)
			},
			async readUsageSnapshot(input: {
				day: string
				weekStart: string
				dailyResources: ReadonlyArray<string>
				weeklyResources: ReadonlyArray<string>
				includeStorageBytes?: boolean
			}) {
				const daily = input.dailyResources.map((resource) => {
					if (!isDailyEntitlementResource(resource)) {
						throw new Error(`Invalid daily resource: ${resource}`)
					}
					const existing = readRow(resource, input.day)
					return existing
						? { resource, ...ready(existing) }
						: { resource, outcome: 'needs_bootstrap' as const }
				})
				const weekly = input.weeklyResources.map((resource) => {
					if (!isDailyEntitlementResource(resource)) {
						throw new Error(`Invalid daily resource: ${resource}`)
					}
					return {
						resource,
						outcome: 'ready' as const,
						count: sumRange(resource, input.weekStart, input.day),
					}
				})
				const storageBytes = input.includeStorageBytes
					? (() => {
							const existing = storageByUser.get(userId)
							if (!existing) return { outcome: 'needs_bootstrap' as const }
							return storageReady(existing)
						})()
					: null
				return { daily, weekly, storageBytes }
			},
			async readRange(input: {
				resource: string
				startDay: string
				endDay: string
			}) {
				if (!isDailyEntitlementResource(input.resource)) {
					throw new Error(`Invalid daily resource: ${input.resource}`)
				}
				return {
					outcome: 'ready' as const,
					count: sumRange(input.resource, input.startDay, input.endDay),
				}
			},
			async readDailyTrend(input?: { now?: string }) {
				const now = input?.now ? new Date(input.now) : new Date()
				const safeNow = Number.isNaN(now.valueOf()) ? new Date() : now
				const endDay = utcDayKey(safeNow)
				const start = new Date(safeNow)
				start.setUTCDate(
					start.getUTCDate() - (userMeterDailyCounterRetentionDays - 1),
				)
				const startDay = utcDayKey(start)
				const counters: Array<UserMeterDailyTrendCounterRow> = []
				for (const [entryKey, row] of rows) {
					const separator = entryKey.indexOf('\0')
					if (separator < 0) continue
					const resource = entryKey.slice(0, separator)
					const day = entryKey.slice(separator + 1)
					if (!isDailyEntitlementResource(resource)) continue
					if (day < startDay || day > endDay) continue
					counters.push({
						resource,
						day,
						count: row.count,
					})
				}
				counters.sort((left, right) => {
					const byDay = left.day.localeCompare(right.day)
					if (byDay !== 0) return byDay
					return left.resource.localeCompare(right.resource)
				})
				const uniqueWorkerDayCounts = new Map<string, number>()
				for (const key of dynamicWorkerDays) {
					const separator = key.indexOf('\0')
					if (separator < 0) continue
					const day = key.slice(0, separator)
					if (day < startDay || day > endDay) continue
					uniqueWorkerDayCounts.set(
						day,
						(uniqueWorkerDayCounts.get(day) ?? 0) + 1,
					)
				}
				const uniqueWorkerDays: Array<UserMeterDailyTrendUniqueWorkerDayRow> = [
					...uniqueWorkerDayCounts.entries(),
				]
					.map(([day, count]) => ({ day, count }))
					.sort((left, right) => left.day.localeCompare(right.day))
				const executeCalls = [...executeCallDays.entries()]
					.filter(([day]) => day >= startDay && day <= endDay)
					.map(([day, count]) => ({ day, count }))
					.sort((left, right) => left.day.localeCompare(right.day))
				return {
					retentionDays: userMeterDailyCounterRetentionDays,
					startDay,
					endDay,
					counters,
					uniqueWorkerDays,
					executeCalls,
				}
			},
			async claimDynamicWorkerDay(input: {
				workerId: string
				day: string
				createdAt: string
			}) {
				const key = `${input.day}\0${input.workerId}`
				if (dynamicWorkerDays.has(key)) return { created: false }
				dynamicWorkerDays.add(key)
				return { created: true }
			},
			async claimDynamicWorkerDayWithinLimit(input: {
				workerId: string
				resource: string
				day: string
				limit: number
				createdAt: string
				weekStart?: string
				weekLimit?: number | null
			}) {
				const key = `${input.day}\0${input.workerId}`
				if (dynamicWorkerDays.has(key)) {
					const existing = readRow(input.resource, input.day)
					return {
						...ready(existing ?? { count: 0, revision: 0 }),
						created: false,
						consumed: false,
						weekCount: input.weekStart
							? sumRange(input.resource, input.weekStart, input.day)
							: undefined,
					}
				}
				const result = await consumeCounter({
					...input,
					updatedAt: input.createdAt,
				})
				if (result.outcome === 'needs_bootstrap') return result
				if (result.consumed) dynamicWorkerDays.add(key)
				return { ...result, created: result.consumed }
			},
			async admitExecuteCall(input: {
				nowMs: number
				limitPerMinute: number
				repeat?: ExecuteRepeatInput
			}) {
				const windows = executeAdmissionByUser.get(userId) ?? {
					minuteWindow: { minute: 0, count: 0 },
					repeatWindow: new ExecuteRepeatWindow(),
				}
				executeAdmissionByUser.set(userId, windows)
				const result = admitExecuteCallInWindows({ ...input, ...windows })
				if (result.admitted) {
					const day = utcDayKey(new Date(input.nowMs))
					executeCallDays.set(day, (executeCallDays.get(day) ?? 0) + 1)
				}
				return result
			},
			async refund(input: {
				resource: string
				day: string
				updatedAt: string
			}) {
				const existing = readRow(input.resource, input.day)
				if (!existing) {
					return {
						outcome: 'ready' as const,
						count: 0,
						revision: 0,
						mirrorUpdatedAt: userMeterMirrorUpdatedAtToken(0),
					}
				}
				const next = {
					count: Math.max(0, existing.count - 1),
					revision: existing.revision + 1,
				}
				rows.set(counterKey(input.resource, input.day), next)
				return ready(next)
			},
			async initializeStorageBytes(input: {
				bytes: number
				updatedAt: string
			}) {
				const existing = storageByUser.get(userId)
				if (existing) return { ...storageReady(existing), created: false }
				const row = {
					bytes: Math.max(0, Math.trunc(input.bytes) || 0),
					revision: 1,
					updatedAt: input.updatedAt,
				}
				storageByUser.set(userId, row)
				return { ...storageReady(row), created: true }
			},
			async readStorageBytes() {
				const existing = storageByUser.get(userId)
				if (!existing) return { outcome: 'needs_bootstrap' as const }
				return storageReady(existing)
			},
			async reserveStorageBytes(input: {
				requested: number
				limit: number
				updatedAt: string
			}) {
				const requested = Math.max(0, Math.trunc(input.requested) || 0)
				const existing = storageByUser.get(userId)
				if (!existing) return { outcome: 'needs_bootstrap' as const }
				if (
					requested > 0 &&
					(input.limit < 1 || existing.bytes + requested > input.limit)
				) {
					return { ...storageReady(existing), reserved: false }
				}
				if (requested === 0) {
					return { ...storageReady(existing), reserved: true }
				}
				const next = {
					bytes: existing.bytes + requested,
					revision: existing.revision + 1,
					updatedAt: input.updatedAt,
				}
				storageByUser.set(userId, next)
				return { ...storageReady(next), reserved: true }
			},
			async setStorageBytes(input: { bytes: number; updatedAt: string }) {
				const bytes = Math.max(0, Math.trunc(input.bytes) || 0)
				const existing = storageByUser.get(userId)
				if (!existing) {
					const row = { bytes, revision: 1, updatedAt: input.updatedAt }
					storageByUser.set(userId, row)
					return { ...storageReady(row), created: true }
				}
				const next = {
					bytes,
					revision: existing.revision + 1,
					updatedAt: input.updatedAt,
				}
				storageByUser.set(userId, next)
				return { ...storageReady(next), created: false }
			},
			async reconcileStorageBytes(input: {
				bytes: number
				expectedRevision: number
				updatedAt: string
			}) {
				const bytes = Math.max(0, Math.trunc(input.bytes) || 0)
				const existing = storageByUser.get(userId)
				if (!existing) {
					return { outcome: 'needs_bootstrap' as const }
				}
				if (existing.revision !== input.expectedRevision) {
					return { ...storageReady(existing), applied: false }
				}
				const next = {
					bytes,
					revision: existing.revision + 1,
					updatedAt: input.updatedAt,
				}
				storageByUser.set(userId, next)
				return { ...storageReady(next), applied: true }
			},
			async markDeleting(input: { deletingAt: string }) {
				const created = deletion.deletingAt == null
				if (created) deletion.deletingAt = input.deletingAt
				dropLapsedLeasesWhileDeleting()
				const leaseCount = deletion.leases.size
				return {
					deletingAt: deletion.deletingAt ?? input.deletingAt,
					created,
					leaseCount,
					blockingLeases: [...deletion.leases.values()].map((lease) => ({
						holder: lease.holder,
						acquiredAt: lease.acquiredAt,
					})),
				}
			},
			async clearDeleting(input?: { expectedDeletingAt?: string }) {
				if (deletion.deletingAt == null) return { cleared: false }
				if (
					input?.expectedDeletingAt != null &&
					deletion.deletingAt !== input.expectedDeletingAt
				) {
					return { cleared: false }
				}
				deletion.deletingAt = null
				return { cleared: true }
			},
			async acquireWriteLease(input: {
				token: string
				holder: string
				acquiredAt: string
			}) {
				const existing = deletion.leases.get(input.token)
				if (existing) return { acquired: true }
				if (deletion.deletingAt != null) return { acquired: false }
				deletion.leases.set(input.token, {
					holder: input.holder,
					acquiredAt: input.acquiredAt,
					pendingRepairId: null,
					expiresAtMs: Date.now() + writeLeaseTtlMs,
				})
				return { acquired: true }
			},
			async renewWriteLease(input: { token: string }) {
				dropLapsedLeasesWhileDeleting()
				const existing = deletion.leases.get(input.token)
				if (!existing) return { renewed: false }
				existing.expiresAtMs = Date.now() + writeLeaseTtlMs
				return { renewed: true }
			},
			async releaseWriteLease(input: { token: string }) {
				dropLapsedLeasesWhileDeleting()
				return { released: deletion.leases.delete(input.token) }
			},
			async assertWriteLeaseHeld(input: { token: string }) {
				dropLapsedLeasesWhileDeleting()
				return { held: deletion.leases.has(input.token) }
			},
			async prepareWriteLeaseRepair(input: {
				token: string
				expectedAcquiredAt: string
			}) {
				const existing = deletion.leases.get(input.token)
				if (!existing) {
					return { prepared: false as const }
				}
				if (existing.acquiredAt !== input.expectedAcquiredAt) {
					throw new Error(
						'Active account write lease did not match repair request.',
					)
				}
				if (!existing.pendingRepairId) {
					existing.pendingRepairId = crypto.randomUUID()
				}
				return {
					prepared: true as const,
					repairId: existing.pendingRepairId,
					token: input.token,
					holder: existing.holder,
					acquiredAt: existing.acquiredAt,
				}
			},
			async finalizeWriteLeaseRepair(input: {
				token: string
				repairId: string
				expectedAcquiredAt: string
			}) {
				const existing = deletion.leases.get(input.token)
				if (!existing) return { finalized: true }
				if (
					existing.acquiredAt !== input.expectedAcquiredAt ||
					existing.pendingRepairId !== input.repairId
				) {
					throw new Error(
						'Active account write lease did not match repair request.',
					)
				}
				deletion.leases.delete(input.token)
				return { finalized: true }
			},
			async readDeletionState() {
				return { deletingAt: deletion.deletingAt }
			},
			async listWriteLeases(
				input: {
					pageSize?: number
					startAfter?: string | null
				} = {},
			) {
				return pageWriteLeases(input)
			},
			async countActiveWriteLeases() {
				dropLapsedLeasesWhileDeleting()
				const nowMs = Date.now()
				return {
					count: [...deletion.leases.values()].filter(
						(lease) => lease.expiresAtMs > nowMs,
					).length,
				}
			},
			async touchInboundConnectionLastUsed(input: {
				clientId: string
				lastUsedAt: string
			}) {
				const previous = lastUsed.get(input.clientId) ?? null
				const cutoff = new Date(
					Date.parse(input.lastUsedAt) - 5 * 60 * 1000,
				).toISOString()
				if (previous != null && previous >= cutoff) {
					return { updated: false }
				}
				lastUsed.set(input.clientId, input.lastUsedAt)
				return { updated: true }
			},
			async listInboundConnectionLastUsed() {
				return [...lastUsed.entries()]
					.map(([clientId, lastUsedAt]) => ({ clientId, lastUsedAt }))
					.sort((left, right) => {
						const byTime = right.lastUsedAt.localeCompare(left.lastUsedAt)
						if (byTime !== 0) return byTime
						return left.clientId.localeCompare(right.clientId)
					})
			},
			async forgetInboundConnectionLastUsed(input: { clientId: string }) {
				lastUsed.delete(input.clientId)
				return { ok: true as const }
			},
			async purge() {
				const deletingAt = deletion.deletingAt
				rows.clear()
				storageByUser.delete(userId)
				deletion.leases.clear()
				deletion.deletingAt = deletingAt
				lastUsed.clear()
				return { ok: true as const }
			},
			async exportCounters(
				input: {
					pageSize?: number
					startAfter?: string | null
				} = {},
			) {
				const counters = [...rows.entries()].map(([entryKey, row]) => {
					const [resource, day] = entryKey.split('\0')
					return {
						resource: resource as DailyEntitlementResource,
						day: day!,
						count: row.count,
						revision: row.revision,
						updatedAt: new Date().toISOString(),
						mirrorUpdatedAt: userMeterMirrorUpdatedAtToken(row.revision),
					}
				})
				const includeFirstPageState =
					typeof input.startAfter !== 'string' || input.startAfter.length === 0
				const storage = includeFirstPageState
					? storageByUser.get(userId)
					: undefined
				const storageBytesState: UserMeterStorageBytesState | null = storage
					? {
							bytes: storage.bytes,
							revision: storage.revision,
							updatedAt: storage.updatedAt,
							mirrorUpdatedAt: userMeterMirrorUpdatedAtToken(storage.revision),
						}
					: null
				const deletionState = includeFirstPageState
					? readDeletionStateExport()
					: null
				const inboundConnectionLastUsed = includeFirstPageState
					? [...lastUsed.entries()].map(([clientId, lastUsedAt]) => ({
							clientId,
							lastUsedAt,
						}))
					: null
				return {
					counters,
					storageBytesState,
					deletionState,
					inboundConnectionLastUsed,
					nextStartAfter: null,
					truncated: false,
				}
			},
		}
	}

	const env = {
		USER_METER: {
			idFromName: (name: string) => ({ name, toString: () => name }),
			get: (id: { name: string }) => meterFor(id.name),
		},
	} as unknown as { USER_METER: Env['USER_METER'] }

	return {
		env,
		metersByUser,
		storageByUser,
		deletionByUser,
		async seed(input: {
			userId: string
			resource: DailyEntitlementResource
			day: string
			count: number
		}) {
			await meterFor(input.userId).initialize({
				resource: input.resource,
				day: input.day,
				count: input.count,
				updatedAt: new Date().toISOString(),
			})
		},
		async seedStorageBytes(input: {
			userId: string
			bytes: number
			updatedAt?: string
		}) {
			await meterFor(input.userId).initializeStorageBytes({
				bytes: input.bytes,
				updatedAt: input.updatedAt ?? new Date().toISOString(),
			})
		},
	}
}

export function createWaitUntilDrain() {
	const tasks: Array<Promise<unknown>> = []
	return {
		waitUntil(promise: Promise<unknown>) {
			tasks.push(promise)
		},
		async drain() {
			await Promise.all(tasks)
			tasks.length = 0
		},
	}
}

/**
 * Minimal D1 stub for the OwnerId write gate used by
 * {@link withAccountWriteLease} in node tests. The DO handles all lease
 * storage; D1 only answers the person / personal-org / team-org point gates.
 * The soft-deleted-person probe is intentionally unmatched so stubs return
 * null (no tombstone) from their default `first()` path.
 */
export function createPermissiveAccountWriteLeaseDbHooks() {
	return {
		supportsDeletingAtQuery(query: string) {
			const compact = query.replace(/\s+/g, ' ')
			return (
				compact.includes(
					'SELECT deleting_at FROM users WHERE stable_user_id',
				) ||
				(compact.includes(
					'SELECT deleting_at, stable_user_id, personal_org_id',
				) &&
					compact.includes('FROM users') &&
					compact.includes('stable_user_id = ? OR personal_org_id = ?')) ||
				(/FROM orgs\b/.test(compact) &&
					compact.includes('deleting_at') &&
					/\bWHERE id = \?/.test(compact))
			)
		},
		deletingAtFirstResult() {
			return {
				deleting_at: null as string | null,
				deleted_at: null as string | null,
				stable_user_id: null as string | null,
				personal_org_id: null as string | null,
			}
		},
	}
}

/**
 * Patch `db.prepare` and restore it via `using` even when the body throws.
 */
export function withPatchedDbPrepare(
	db: D1Database,
	patch: (originalPrepare: D1Database['prepare']) => D1Database['prepare'],
) {
	const originalPrepare = db.prepare.bind(db)
	db.prepare = patch(originalPrepare)
	return {
		[Symbol.dispose]() {
			db.prepare = originalPrepare
		},
	}
}
