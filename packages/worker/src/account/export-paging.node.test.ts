import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import * as packageRegistrySource from '#worker/package-registry/source.ts'
import {
	createAccountExport,
	createAccountExportManifest,
	readAccountExportSection,
} from './export.ts'
import {
	createMailboxBinding,
	createMigratedDb,
	createMigratedDbWithUser,
	createSignedR2Cursor,
	createStubNamespace,
	insertTestUser,
	rawMimeReference,
} from '#worker/test-support/account-export.ts'

type SectionInput = Parameters<typeof readAccountExportSection>[0]

function sectionReader(env: Env, mcpUserId = 'user-aaa') {
	return (
		section: SectionInput['section'],
		input: Partial<Omit<SectionInput, 'startAfter'>> & {
			startAfter?: string | null
		} = {},
	) =>
		readAccountExportSection({
			env,
			dbUserId: 1,
			mcpUserId: ownerIdFromStored(mcpUserId),
			section,
			...input,
			startAfter: input.startAfter ?? undefined,
		})
}

const exportUserA = (env: Env) =>
	createAccountExport({
		env,
		dbUserId: 1,
		mcpUserId: ownerIdFromStored('user-aaa'),
	})

async function readAllStorageRunnerIds(
	read: ReturnType<typeof sectionReader>,
	pageSize: number,
) {
	const seen = new Set<string>()
	let startAfter: string | null = null
	for (;;) {
		const page = await read('durable_object_summaries', {
			kind: 'storage_runner',
			pageSize,
			startAfter,
		})
		for (const item of page.items as Array<{ storageId: string }>) {
			expect(Array.isArray(item.storageId)).toBe(false)
			seen.add(item.storageId)
		}
		if (!page.truncated) return seen
		startAfter = page.nextStartAfter
	}
}

test('R2 export pages owned payloads in bounded chunks and reports missing objects', async () => {
	const { sqlite, db } = createMigratedDb()
	for (const [id, stableUserId] of [
		[1, 'user-aaa'],
		[2, 'user-bbb'],
	] as const) {
		insertTestUser(sqlite, {
			id,
			username: `user-${id}`,
			stableUserId,
			avatarKey: `user-avatars/${stableUserId}/avatar.png`,
		})
	}
	const mimeBytes = new TextEncoder().encode('Subject: A\r\n\r\nbody')
	const getEmailBlob = vi.fn(async (key: string) => {
		if (key === 'email-raw:v1:user-aaa/mail-z') {
			throw new Error('temporary R2 outage')
		}
		if (key !== 'email-raw:v1:user-aaa/mail-a') return null
		return {
			size: mimeBytes.byteLength,
			httpEtag: '"etag-a"',
			httpMetadata: { contentType: 'message/rfc822' },
			arrayBuffer: async () => mimeBytes.buffer,
		}
	})
	const read = sectionReader({
		APP_DB: db,
		COOKIE_SECRET: 'test-cookie-secret',
		EMAIL_BLOBS: { get: getEmailBlob },
		COMMUNITY_ASSETS: { get: vi.fn(async () => null) },
		MAILBOX: createMailboxBinding({
			blobReferences: () => [
				rawMimeReference('mail-a'),
				rawMimeReference('mail-z'),
			],
		}),
	} as unknown as Env)

	const first = await read('r2_object')
	expect(first.items).toEqual([
		expect.objectContaining({
			surfaceId: 'user_avatar',
			key: 'user-avatars/user-aaa/avatar.png',
			missing: true,
		}),
	])
	const firstCursor = first.nextStartAfter!
	const tamperedCursor = `${firstCursor.slice(0, -1)}${firstCursor.endsWith('a') ? 'b' : 'a'}`
	await expect(
		read('r2_object', { startAfter: tamperedCursor }),
	).rejects.toThrow('Invalid or unsupported r2_object cursor')
	const legacyCursor = await createSignedR2Cursor({
		secret: 'test-cookie-secret',
		userId: ownerIdFromStored('user-aaa'),
		cursor: {
			v: 1,
			state: { stage: 'email_raw_mime', afterRowid: 1 },
		},
	})
	await expect(read('r2_object', { startAfter: legacyCursor })).rejects.toThrow(
		'restart without startAfter',
	)

	const second = await read('r2_object', { startAfter: first.nextStartAfter })
	expect(second.items).toEqual([
		expect.objectContaining({
			surfaceId: 'email_raw_mime',
			key: 'email-raw:v1:user-aaa/mail-a',
			contentBase64: btoa('Subject: A\r\n\r\nbody'),
			objectComplete: true,
		}),
	])
	expect(second.truncated).toBe(true)
	const third = await read('r2_object', { startAfter: second.nextStartAfter })
	expect(third.items).toEqual([
		expect.objectContaining({
			key: 'email-raw:v1:user-aaa/mail-z',
			unavailable: true,
		}),
	])
	expect(third.truncated).toBe(true)
	expect(third.warnings).toEqual([
		expect.stringContaining('R2 object export failed'),
	])
	const done = await read('r2_object', { startAfter: third.nextStartAfter })
	expect(done.items).toEqual([])
	expect(done.truncated).toBe(false)
	expect(getEmailBlob).not.toHaveBeenCalledWith(
		'email-raw:v1:user-bbb/mail-b',
		expect.anything(),
	)
})

test('R2 export performs bounded keyset work independent of mailbox size', async () => {
	const queries: Array<string> = []
	const { db } = createMigratedDbWithUser({
		onQuery: (query) => queries.push(query),
	})
	const page = await sectionReader({
		APP_DB: db,
		COOKIE_SECRET: 'test-cookie-secret',
		EMAIL_BLOBS: { get: vi.fn(async () => null) },
		COMMUNITY_ASSETS: { get: vi.fn(async () => null) },
		MAILBOX: createMailboxBinding({
			blobReferences: () =>
				Array.from({ length: 502 }, (_, index) =>
					rawMimeReference(`mail-${String(index).padStart(4, '0')}`),
				),
		}),
	} as unknown as Env)('r2_object')
	expect(page.items).toEqual([
		expect.objectContaining({
			key: 'email-raw:v1:user-aaa/mail-0000',
			missing: true,
		}),
	])
	expect(queries.length).toBeLessThanOrEqual(4)
})

test('R2 export cursor detects object overwrite before continuing bytes', async () => {
	const { sqlite, db } = createMigratedDb()
	insertTestUser(sqlite, {
		id: 1,
		username: 'user-a',
		stableUserId: ownerIdFromStored('user-aaa'),
		avatarKey: 'user-avatars/user-aaa/avatar.png',
	})
	const bytes = new Uint8Array(300 * 1024).fill(1)
	let etag = '"v1"'
	const get = vi.fn(
		async (
			_key: string,
			options?: { range?: { offset: number; length: number } },
		) => {
			const offset = options?.range?.offset ?? 0
			const length = options?.range?.length ?? bytes.byteLength
			const chunk = bytes.slice(offset, offset + length)
			return {
				size: bytes.byteLength,
				httpEtag: etag,
				httpMetadata: { contentType: 'image/png' },
				arrayBuffer: async () => chunk.buffer,
			}
		},
	)
	const head = vi.fn(async () => ({ size: bytes.byteLength, httpEtag: etag }))
	const read = sectionReader({
		APP_DB: db,
		COOKIE_SECRET: 'test-cookie-secret',
		COMMUNITY_ASSETS: { get, head },
		EMAIL_BLOBS: { get: vi.fn(async () => null), head },
	} as unknown as Env)

	const first = await read('r2_object')
	expect(first.items).toEqual([
		expect.objectContaining({
			offset: 0,
			etag: '"v1"',
			objectComplete: false,
		}),
	])
	etag = '"v2"'
	const second = await read('r2_object', { startAfter: first.nextStartAfter })
	expect(second.items).toEqual([
		expect.objectContaining({
			changed: true,
			change: 'object_overwritten',
			expectedEtag: '"v1"',
			actualEtag: '"v2"',
		}),
	])
	expect(get).toHaveBeenCalledTimes(1)
})

test('R2 export cursor keeps stable row identity when inventory mutates', async () => {
	const { db } = createMigratedDbWithUser()
	const get = vi.fn(async (key: string) => {
		const bytes = new TextEncoder().encode(key)
		return {
			size: bytes.byteLength,
			httpEtag: `"${key}"`,
			arrayBuffer: async () => bytes.buffer,
		}
	})
	const blobReferences = [
		rawMimeReference('mail-a'),
		rawMimeReference('mail-b'),
	]
	const read = sectionReader({
		APP_DB: db,
		COOKIE_SECRET: 'test-cookie-secret',
		EMAIL_BLOBS: { get },
		COMMUNITY_ASSETS: { get: vi.fn(async () => null) },
		MAILBOX: createMailboxBinding({ blobReferences: () => blobReferences }),
	} as unknown as Env)

	const first = await read('r2_object')
	blobReferences.unshift(rawMimeReference('mail-00'))
	const second = await read('r2_object', { startAfter: first.nextStartAfter })
	expect(second.items).toEqual([
		expect.objectContaining({ key: 'email-raw:v1:user-aaa/mail-b' }),
	])
	expect(get.mock.calls.map(([key]) => key)).toEqual([
		'email-raw:v1:user-aaa/mail-a',
		'email-raw:v1:user-aaa/mail-b',
	])
})

test('durable object discovery pages high-cardinality storage ids without nested arrays', async () => {
	const ids = Array.from(
		{ length: 502 },
		(_, index) => `storage-${String(index).padStart(4, '0')}`,
	)
	let maxRows = 0
	const db = {
		prepare(query: string) {
			return {
				bind(...params: Array<unknown>) {
					return {
						async all<T>() {
							if (query.includes('FROM user_storage_buckets')) {
								if (!query.includes('storage_id > ?')) {
									return { results: [] as Array<T> }
								}
								const afterId = String(params[1])
								const limit = Number(params[2])
								const rows = ids
									.filter((id) => id > afterId)
									.slice(0, limit)
									.map((id) => ({ id }))
								maxRows = Math.max(maxRows, rows.length)
								return { results: rows as Array<T> }
							}
							throw new Error(`Unexpected query: ${query}`)
						},
						async first<T>() {
							return null as T | null
						},
					}
				},
			}
		},
	} as unknown as D1Database
	const read = sectionReader(
		{
			APP_DB: db,
			JOBS: { listJobStorageIdsForUser: async () => [] },
		} as unknown as Env,
		'user-a',
	)

	expect((await readAllStorageRunnerIds(read, 100)).size).toBe(502)
	expect(maxRows).toBeLessThanOrEqual(101)
})

test('run_records section exports runs, ledger, and dedicated state and pages across phases', async () => {
	const { db } = createMigratedDbWithUser()
	// RunLog rows pass through unchanged; only ids and runId joins matter.
	const run = { id: 'run-export-1', status: 'success' }
	const logs = [
		{ runId: 'run-export-1', sequence: 0, message: 'starting' },
		{ runId: 'run-export-1', sequence: 1, message: 'done' },
	]
	// Keyed package-invocation idempotency ledger row stored in the same
	// RunLog DO; exported through the same run_records section.
	const packageInvocation = { id: 'invocation-export-1', idempotencyKey: 'e' }
	const workflowProjection = { id: 'wf-export-1', status: 'complete' }
	const jobRunObservability = { jobId: 'job-export-1', runCount: 1 }
	const packageRunSuccess = { packageId: 'pkg-1', successCount: 2 }
	const activationMilestone = {
		milestone: 'package_activated',
		packageId: 'pkg-1',
	}
	const skillRead = {
		id: 'skill-read-1',
		actorId: 'person-1',
		filePath: 'skills/writing/SKILL.md',
	}
	const fullPage = {
		runs: [run],
		logs,
		packageInvocations: [packageInvocation],
		workflowProjections: [workflowProjection],
		jobRunObservability: [jobRunObservability],
		packageRunSuccesses: [packageRunSuccess],
		activationMilestones: [activationMilestone],
		skillReads: [skillRead],
		nextStartAfter: null as string | null,
		truncated: false,
	}
	const exportRuns = vi.fn(async () => fullPage)
	const env = {
		APP_DB: db,
		STORAGE_RUNNER: createStubNamespace({
			exportStorage: async () => ({
				entries: [],
				truncated: false,
				nextStartAfter: null,
			}),
		}),
		RUN_LOG: createStubNamespace({
			exportRuns,
			listStorageIds: async () => ['job:nightly'],
			summarize: async () => ({
				since: '1970-01-01T00:00:00.000Z',
				total: 1,
				errors: 0,
				ignored: 0,
				resolved: 0,
				running: 0,
				bySurface: [],
			}),
		}),
		JOBS: {
			exportUser: async () => ({ userId: ownerIdFromStored('user-aaa') }),
		},
	} as unknown as Env
	const read = sectionReader(env)

	const accountExport = await exportUserA(env)
	// One run plus one row from each RunLog export phase.
	expect(accountExport.manifest.sections.run_records?.count).toBe(7)
	expect(accountExport.durableObjects.runRecords).toEqual(fullPage)

	const section = await read('run_records')
	expect(section.truncated).toBe(false)
	expect(section.items).toEqual([
		{ run, logs },
		{ packageInvocation },
		{ workflowProjection },
		{ jobRunObservability },
		{ packageRunSuccess },
		{ activationMilestone },
		{ skillRead },
	])

	const empty = {
		...fullPage,
		runs: [],
		logs: [],
		packageInvocations: [],
		workflowProjections: [],
		jobRunObservability: [],
		packageRunSuccesses: [],
		activationMilestones: [],
		skillReads: [],
	}
	exportRuns
		.mockResolvedValueOnce({
			...empty,
			runs: [run],
			nextStartAfter: 'invocation-ledger:',
			truncated: true,
		})
		.mockResolvedValueOnce({
			...empty,
			workflowProjections: [workflowProjection],
		})
	const pageOne = await read('run_records', { pageSize: 1 })
	expect(pageOne.items).toEqual([{ run, logs: [] }])
	expect(pageOne.truncated).toBe(true)
	expect(pageOne.nextStartAfter).toBe('invocation-ledger:')
	const pageTwo = await read('run_records', {
		pageSize: 1,
		startAfter: pageOne.nextStartAfter,
	})
	expect(pageTwo.items).toEqual([{ workflowProjection }])
	expect(pageTwo.truncated).toBe(false)
	expect(exportRuns).toHaveBeenLastCalledWith(
		expect.objectContaining({ pageSize: 1, startAfter: 'invocation-ledger:' }),
	)
})

test('account export includes user_meter counters, pages them, and warns on truncation', async () => {
	const { db } = createMigratedDbWithUser()
	const counters = [
		{ resource: 'email_sends_per_day', day: '2026-07-30', count: 2 },
		{ resource: 'execute_unique_workers_per_day', day: '2026-07-30', count: 5 },
		{ resource: 'outbound_fetches_per_day', day: '2026-07-31', count: 1 },
	]
	const storageBytesState = {
		bytes: 4_096,
		revision: 3,
		updatedAt: '2026-07-31T03:00:00.000Z',
		mirrorUpdatedAt: 'r/00000000000000000003',
	}
	const deletionState = {
		deletingAt: '2026-07-31 03:10:00',
		activeWriteLeaseCount: 1,
		writeLeases: [{ acquiredAt: '2026-07-31 03:00:00' }],
	}
	const exportCounters = vi.fn(
		async (input: { pageSize?: number; startAfter?: string | null }) => {
			const pageSize = input.pageSize ?? 100
			const startIndex = input.startAfter
				? counters.findIndex(
						(row) => `${row.day}:${row.resource}` === input.startAfter,
					) + 1
				: 0
			const page = counters.slice(startIndex, startIndex + pageSize)
			const truncated = startIndex + pageSize < counters.length
			const isFirstPage = !input.startAfter
			return {
				counters: page,
				storageBytesState: isFirstPage ? storageBytesState : null,
				deletionState: isFirstPage ? deletionState : null,
				inboundConnectionLastUsed: isFirstPage ? [] : null,
				nextStartAfter: truncated
					? `${page.at(-1)!.day}:${page.at(-1)!.resource}`
					: null,
				truncated,
			}
		},
	)
	const idFromName = vi.fn((name: string) => name as unknown as DurableObjectId)
	const env = {
		APP_DB: db,
		USER_METER: { idFromName, get: () => ({ exportCounters }) },
	} as unknown as Env
	const read = sectionReader(env)

	const accountExport = await exportUserA(env)
	expect(idFromName).toHaveBeenCalledWith('user-aaa')
	// 3 counters + storage state + deletingAt + 1 lease
	expect(accountExport.manifest.sections.user_meter?.count).toBe(6)
	expect(accountExport.durableObjects.userMeter).toEqual({
		counters,
		storageBytesState,
		deletionState,
		inboundConnectionLastUsed: [],
		nextStartAfter: null,
		truncated: false,
	})
	expect(accountExport.manifest.warnings).not.toEqual(
		expect.arrayContaining([
			expect.stringContaining('entitlement_daily_counters'),
		]),
	)

	const first = await read('user_meter', { pageSize: 2 })
	expect(first).toMatchObject({
		items: counters.slice(0, 2),
		storageBytesState,
		deletionState,
		inboundConnectionLastUsed: [],
		truncated: true,
		nextStartAfter: '2026-07-30:execute_unique_workers_per_day',
	})
	const second = await read('user_meter', {
		pageSize: 2,
		startAfter: first.nextStartAfter,
	})
	expect(second).toMatchObject({
		items: counters.slice(2),
		storageBytesState: null,
		deletionState: null,
		inboundConnectionLastUsed: null,
		truncated: false,
		nextStartAfter: null,
	})
	expect(exportCounters).toHaveBeenCalledWith(
		expect.objectContaining({
			pageSize: 2,
			startAfter: first.nextStartAfter,
		}),
	)

	exportCounters.mockImplementation(async () => ({
		counters: [counters[0]!],
		storageBytesState: null,
		deletionState: null,
		inboundConnectionLastUsed: null,
		nextStartAfter: 'cursor-more',
		truncated: true,
	}))
	const truncatedExport = await exportUserA(env)
	expect(truncatedExport.durableObjects.userMeter?.truncated).toBe(true)
	expect(truncatedExport.manifest.sections.user_meter?.count).toBe(1)
	expect(truncatedExport.manifest.warnings).toContain(
		'User meter counters were truncated in the full export; use accountExportSection with section "user_meter" to retrieve additional pages.',
	)
})

test('account export includes mailbox rows, pages them, and warns on truncation', async () => {
	const { db } = createMigratedDbWithUser()
	// Mailbox DO rows pass through unchanged.
	const rows = [
		{ kind: 'thread', row: { id: 'thread-1', subjectNormalized: 'hello' } },
		{ kind: 'message', row: { id: 'message-1', threadId: 'thread-1' } },
		{ kind: 'attachment', row: { id: 'attachment-1', messageId: 'message-1' } },
	]
	const exportMailbox = vi.fn(
		async (input: { pageSize?: number; startAfter?: string | null }) => {
			const pageSize = input.pageSize ?? 100
			const startIndex = input.startAfter
				? rows.findIndex((row) => row.row.id === input.startAfter) + 1
				: 0
			const page = rows.slice(startIndex, startIndex + pageSize)
			const truncated = startIndex + pageSize < rows.length
			return {
				rows: page,
				nextStartAfter: truncated ? page.at(-1)!.row.id : null,
				truncated,
			}
		},
	)
	const countMailbox = vi.fn(async () => ({
		threads: 1,
		messages: 1,
		attachments: 1,
		deliveryEvents: 0,
	}))
	const idFromName = vi.fn((name: string) => name as unknown as DurableObjectId)
	const env = {
		APP_DB: db,
		MAILBOX: { idFromName, get: () => ({ exportMailbox, countMailbox }) },
	} as unknown as Env
	const read = sectionReader(env)

	const accountExport = await exportUserA(env)
	expect(idFromName).toHaveBeenCalledWith('user-aaa')
	expect(accountExport.manifest.sections.mailbox?.count).toBe(3)
	expect(accountExport.durableObjects.mailbox).toEqual({
		rows,
		nextStartAfter: null,
		truncated: false,
	})
	for (const table of [
		'email_threads',
		'email_messages',
		'email_attachments',
		'email_delivery_events',
	]) {
		expect(accountExport.d1).not.toHaveProperty(table)
		expect(accountExport.manifest.sections).not.toHaveProperty(`d1.${table}`)
	}

	const first = await read('mailbox', { pageSize: 2 })
	expect(first).toMatchObject({
		items: rows.slice(0, 2),
		truncated: true,
		nextStartAfter: 'message-1',
	})
	const second = await read('mailbox', {
		pageSize: 2,
		startAfter: first.nextStartAfter,
	})
	expect(second).toMatchObject({
		items: rows.slice(2),
		truncated: false,
		nextStartAfter: null,
	})

	exportMailbox.mockImplementation(async () => ({
		rows: [rows[0]!],
		nextStartAfter: 'cursor-more',
		truncated: true,
	}))
	const truncatedExport = await exportUserA(env)
	expect(truncatedExport.durableObjects.mailbox?.truncated).toBe(true)
	expect(truncatedExport.manifest.warnings).toContain(
		'Mailbox rows were truncated in the full export; use accountExportSection with section "mailbox" to retrieve additional pages.',
	)
})

test('storage_runners count matches ids enumerable by discovery paging, including RunLog-only ids', async () => {
	const { sqlite, db } = createMigratedDbWithUser()
	sqlite.exec(`
		INSERT INTO jobs (
			id, user_id, name, source_id, storage_id, schedule_json, timezone,
			caller_context_json, created_at, updated_at, next_run_at
		) VALUES (
			'job-1', 'user-aaa', 'Job', 'src-job-1', 'job:job-1', '{}', 'UTC',
			'{}', '2026-07-05', '2026-07-05', '2026-07-05'
		);
		INSERT INTO user_storage_buckets (
			user_id, storage_id, kind, created_at, last_seen_at
		) VALUES (
			'user-aaa', 'exec:adhoc', 'execute', '2026-07-05', '2026-07-05'
		);
		INSERT INTO saved_packages (
			id, user_id, name, kody_id, description, tags_json, source_id,
			has_app, hidden, is_private, created_at, updated_at
		) VALUES (
			'pkg-1', 'user-aaa', 'Pkg', 'pkg', '', '[]',
			'src-1', 1, 0, 1, '2026-07-05', '2026-07-05'
		);
	`)
	const env = {
		APP_DB: db,
		RUN_LOG: createStubNamespace({
			listStorageIds: async () => [
				'exec:adhoc',
				'exec:runlog-only',
				'job:job-1',
			],
		}),
	} as unknown as Env
	const manifest = await createAccountExportManifest({
		env,
		dbUserId: 1,
		mcpUserId: ownerIdFromStored('user-aaa'),
	})
	const expectedCount = manifest.sections.storage_runners?.count
	expect(expectedCount).toBeGreaterThan(0)

	const seen = await readAllStorageRunnerIds(sectionReader(env), 2)
	expect(seen.size).toBe(expectedCount)
	expect(seen.has('exec:runlog-only')).toBe(true)
})

test('storage_runner section exports a RunLog-only storage id', async () => {
	const { db } = createMigratedDbWithUser()
	const exportStorage = vi.fn(async () => ({
		entries: [{ key: 'runlog', value: { ok: true } }],
		truncated: false,
		nextStartAfter: null,
	}))
	const env = {
		APP_DB: db,
		STORAGE_RUNNER: createStubNamespace({ exportStorage }),
		RUN_LOG: createStubNamespace({
			listStorageIds: async () => ['exec:runlog-export-only'],
		}),
	} as unknown as Env

	const manifest = await createAccountExportManifest({
		env,
		dbUserId: 1,
		mcpUserId: ownerIdFromStored('user-aaa'),
	})
	expect(manifest.sections.storage_runners?.count).toBe(1)

	const section = await sectionReader(env)('storage_runner', {
		storageId: 'exec:runlog-export-only',
	})
	expect(section.items).toEqual([{ key: 'runlog', value: { ok: true } }])
	expect(exportStorage).toHaveBeenCalledTimes(1)
})

test('storage_runner section reads do not load manifests for D1-known rows', async () => {
	const loadManifest = vi.spyOn(
		packageRegistrySource,
		'loadPackageManifestBySourceId',
	)
	loadManifest.mockRejectedValue(new Error('manifest should not be loaded'))
	try {
		const { sqlite, db } = createMigratedDbWithUser()
		sqlite.exec(`
			INSERT INTO user_storage_buckets (
				user_id, storage_id, kind, created_at, last_seen_at
			) VALUES (
				'user-aaa', 'exec:section-only', 'execute',
				'2026-07-05', '2026-07-05'
			);
		`)
		const exportStorage = vi.fn(async () => ({
			entries: [],
			truncated: false,
			nextStartAfter: null,
		}))
		await sectionReader({
			APP_DB: db,
			STORAGE_RUNNER: createStubNamespace({ exportStorage }),
		} as unknown as Env)('storage_runner', { storageId: 'exec:section-only' })
		expect(exportStorage).toHaveBeenCalledTimes(1)
		expect(loadManifest).not.toHaveBeenCalled()
	} finally {
		loadManifest.mockRestore()
	}
})
