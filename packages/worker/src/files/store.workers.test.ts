import {
	env,
	runInDurableObject,
	applyD1Migrations,
	type D1Migration,
} from 'cloudflare:test'
import { beforeAll, expect, test } from 'vitest'
import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { fileStoreRpc, fileStoreName } from './client.ts'
import type { FileStore } from './store.ts'

beforeAll(async () => {
	await applyD1Migrations(
		env.APP_DB,
		(env as Env & { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS,
	)
})

async function expectWriteError(
	input: Parameters<FileStore['write']>[0],
	message: string,
) {
	const stub = env.FILE_STORE.get(
		env.FILE_STORE.idFromName(fileStoreName(input.ownerId)),
	)
	const result = await runInDurableObject(stub, async (instance: FileStore) => {
		try {
			await instance.write(input)
			return null
		} catch (error) {
			return error instanceof Error ? error.message : String(error)
		}
	})
	expect(result).toContain(message)
}

function workspace() {
	const ownerId = ownerIdFromStored(`org_${crypto.randomUUID()}`)
	const store = fileStoreRpc(env, ownerId)
	const input = {
		ownerId,
		fileId: crypto.randomUUID(),
		writeId: crypto.randomUUID(),
		baseRevisionId: null,
		content: 'Hello',
		actorId: 'alice',
		profileId: null,
		author: 'Alice',
		maxBytes: 100_000,
		create: { name: 'Notes.md', mediaType: 'text/markdown' as const },
	}
	return { ownerId, store, input }
}

test('immutable revisions survive retries and conflicting concurrent writes', async () => {
	const { store, input, ownerId } = workspace()
	const first = await store.write(input)
	expect(first.ok).toBe(true)
	const next = { ...input, create: undefined, baseRevisionId: input.writeId }
	const writes = await Promise.all([
		store.write({
			...next,
			writeId: crypto.randomUUID(),
			content: 'Alice edit',
		}),
		store.write({
			...next,
			writeId: crypto.randomUUID(),
			content: 'Agent edit',
		}),
	])
	expect(writes.filter((write) => write.ok)).toHaveLength(1)
	expect(writes.filter((write) => !write.ok)).toHaveLength(1)
	expect(await store.write(input)).toMatchObject({
		ok: true,
		file: { content: 'Hello', revisionId: input.writeId },
	})
	await expectWriteError({ ...input, actorId: 'bob' }, 'already in use')
	await expectWriteError(
		{ ...input, profileId: 'another-profile' },
		'already in use',
	)
	expect((await store.metadata(ownerId, input.fileId))?.revisions).toHaveLength(
		2,
	)
	await expectWriteError(
		{ ...input, content: 'Different' },
		'different content',
	)
})

test('quota includes history and reads remain available when writes are disabled', async () => {
	const { store, input, ownerId } = workspace()
	await expectWriteError({ ...input, maxBytes: 0 }, 'storage limit')
	await store.write({ ...input, maxBytes: 5 })
	await expectWriteError(
		{
			...input,
			create: undefined,
			baseRevisionId: input.writeId,
			writeId: crypto.randomUUID(),
			maxBytes: 9,
		},
		'storage limit',
	)
	expect((await store.read(ownerId, input.fileId)).content).toBe('Hello')
	expect(await store.inventory(ownerId)).toHaveLength(1)
})

test('workspace isolation, export inventory, deletion and permanent file identities', async () => {
	const { store, input, ownerId } = workspace()
	await store.write(input)
	const other = workspace()
	expect(await other.store.list(other.ownerId)).toEqual([])
	const stub = env.FILE_STORE.get(
		env.FILE_STORE.idFromName(fileStoreName(ownerId)),
	)
	const mismatch = await runInDurableObject(
		stub,
		async (instance: FileStore) => {
			try {
				await instance.list(other.ownerId)
				return null
			} catch (error) {
				return String(error)
			}
		},
	)
	expect(mismatch).toContain('owner mismatch')
	const inventory = await store.inventory(ownerId)
	expect(await env.FILE_BLOBS.get(inventory[0]!)).not.toBeNull()
	expect((await store.exportMetadata(ownerId)).files).toHaveLength(1)
	expect(await store.remove(ownerId, input.fileId)).toBe(true)
	expect(await env.FILE_BLOBS.get(inventory[0]!)).toBeNull()
	await expectWriteError(input, 'deleted')
	expect(await store.list(ownerId)).toEqual([])
	await other.store.write(other.input)
	const otherInventory = await other.store.inventory(other.ownerId)
	await other.store.purge(other.ownerId)
	expect(await other.store.inventory(other.ownerId)).toEqual([])
	expect(await env.FILE_BLOBS.get(otherInventory[0]!)).toBeNull()
})

test('an interrupted upload reserves capacity and retries only the same content', async () => {
	const { store, input, ownerId } = workspace()
	const hash = Array.from(
		new Uint8Array(
			await crypto.subtle.digest(
				'SHA-256',
				new TextEncoder().encode(input.content),
			),
		),
		(byte) => byte.toString(16).padStart(2, '0'),
	).join('')
	const key = `files:v1/${ownerId}/${input.fileId}/${input.writeId}`
	const stub = env.FILE_STORE.get(
		env.FILE_STORE.idFromName(fileStoreName(ownerId)),
	)
	await runInDurableObject(stub, async (_instance, state) => {
		await state.storage.put(`pending:${input.writeId}`, {
			key,
			bytes: 5,
			fileId: input.fileId,
			writeId: input.writeId,
			sha256: hash,
		})
	})
	await expectWriteError({ ...input, content: 'Other' }, 'another upload')
	await expectWriteError(
		{
			...input,
			fileId: crypto.randomUUID(),
			writeId: crypto.randomUUID(),
			maxBytes: 9,
		},
		'storage limit',
	)
	expect(await store.write({ ...input, maxBytes: 5 })).toMatchObject({
		ok: true,
		file: { content: 'Hello' },
	})
	expect(await store.inventory(ownerId)).toEqual([key])
	const pending = await runInDurableObject(
		stub,
		async (_instance, state) =>
			(await state.storage.list({ prefix: 'pending:' })).size,
	)
	expect(pending).toBe(0)
})

test('failed uploads cannot grow the pending catalog without a bound', async () => {
	const { input, ownerId } = workspace()
	const stub = env.FILE_STORE.get(
		env.FILE_STORE.idFromName(fileStoreName(ownerId)),
	)
	await runInDurableObject(stub, async (_instance, state) => {
		for (let index = 0; index < 64; index++) {
			await state.storage.put(`pending:failed-${index}`, {
				bytes: 0,
				fileId: input.fileId,
				writeId: `failed-${index}`,
				key: `failed-${index}`,
				sha256: 'unused',
			})
		}
	})
	await expectWriteError(input, 'Too many incomplete uploads')
})

test('binary revisions preserve raw bytes and charge their decoded size', async () => {
	const { store, input, ownerId } = workspace()
	const original = {
		...input,
		content: 'AP9/', // 00 ff 7f
		maxBytes: 6,
		create: {
			name: 'fixture.bin',
			mediaType: 'application/octet-stream',
			encoding: 'base64' as const,
		},
	}
	expect(await store.write(original)).toMatchObject({
		ok: true,
		file: { encoding: 'base64', content: 'AP9/', revisions: [{ bytes: 3 }] },
	})
	const replacement = {
		...original,
		create: undefined,
		writeId: crypto.randomUUID(),
		baseRevisionId: original.writeId,
		content: 'gP8A',
	}
	await expectWriteError({ ...replacement, content: '!!!!' }, 'valid base64')
	expect((await store.write(replacement)).ok).toBe(true)
	expect((await store.read(ownerId, input.fileId)).content).toBe('gP8A')
	expect((await store.read(ownerId, input.fileId, input.writeId)).content).toBe(
		'AP9/',
	)
	const [originalKey] = (await store.inventory(ownerId)).filter((key) =>
		key.endsWith(input.writeId),
	)
	expect(
		new Uint8Array(
			await (await env.FILE_BLOBS.get(originalKey!))!.arrayBuffer(),
		),
	).toEqual(new Uint8Array([0, 255, 127]))
})

test('directories nest without a depth restriction and cannot lose their children on deletion', async () => {
	const { store, input, ownerId } = workspace()
	let parentId: string | undefined
	const ids: string[] = []
	for (let depth = 0; depth < 12; depth++) {
		const fileId = crypto.randomUUID()
		ids.push(fileId)
		const result = await store.write({
			...input,
			fileId,
			writeId: crypto.randomUUID(),
			content: '',
			create: {
				name: `Folder ${depth}`,
				mediaType: 'application/vnd.kody.directory',
				parentId,
			},
		})
		expect(result).toMatchObject({
			ok: true,
			file: { id: fileId, ...(parentId ? { parentId } : {}) },
		})
		parentId = fileId
	}
	const root = ids[0]!
	const stub = env.FILE_STORE.get(
		env.FILE_STORE.idFromName(fileStoreName(ownerId)),
	)
	const error = await runInDurableObject(stub, async (instance: FileStore) => {
		try {
			await instance.remove(ownerId, root)
			return null
		} catch (error) {
			return (error as Error).message
		}
	})
	expect(error).toContain('Remove its contents first')
	expect(await store.list(ownerId)).toHaveLength(12)
	await expectWriteError(
		{
			...input,
			fileId: crypto.randomUUID(),
			content: 'not a document',
			create: {
				name: 'Invalid folder',
				mediaType: 'application/vnd.kody.directory',
			},
		},
		'Invalid directory',
	)
})

test('rename and move preserve contents and ids, reject cycles and stale metadata', async () => {
	const { store, input, ownerId } = workspace()
	await store.write(input)
	const folderId = crypto.randomUUID()
	await store.write({
		...input,
		fileId: folderId,
		writeId: crypto.randomUUID(),
		content: '',
		create: { name: 'Assets', mediaType: 'application/vnd.kody.directory' },
	})
	const access = {
		ownerId,
		allowedIds: [input.fileId, folderId],
		writableParents: [folderId],
		canCreate: true,
	}
	const rename = {
		...access,
		fileId: input.fileId,
		action: 'rename' as const,
		name: 'Renamed.md',
		expectedVersion: 0,
		operationId: crypto.randomUUID(),
	}
	const first = await store.manage(rename)
	expect(first).toMatchObject({
		id: input.fileId,
		name: 'Renamed.md',
		metadataVersion: 1,
	})
	expect(await store.manage(rename)).toEqual(first)
	const moved = await store.manage({
		...access,
		fileId: input.fileId,
		action: 'move',
		parentId: folderId,
		expectedVersion: 1,
		operationId: crypto.randomUUID(),
	})
	expect(moved).toMatchObject({ parentId: folderId, metadataVersion: 2 })
	expect((await store.read(ownerId, input.fileId)).content).toBe('Hello')
	const stub = env.FILE_STORE.get(
		env.FILE_STORE.idFromName(fileStoreName(ownerId)),
	)
	const failure = await runInDurableObject(
		stub,
		async (instance: FileStore) => {
			try {
				await instance.manage({
					...access,
					fileId: folderId,
					action: 'move',
					parentId: folderId,
					expectedVersion: 0,
					operationId: crypto.randomUUID(),
				})
				return null
			} catch (error) {
				return (error as Error).message
			}
		},
	)
	expect(failure).toContain('itself or its descendants')
})

test('trash is atomic across a subtree and restore preserves prior independently trashed items', async () => {
	const { store, input, ownerId } = workspace()
	const folderId = input.fileId
	await store.write({
		...input,
		content: '',
		create: { name: 'Folder', mediaType: 'application/vnd.kody.directory' },
	})
	const childId = crypto.randomUUID()
	await store.write({
		...input,
		fileId: childId,
		writeId: crypto.randomUUID(),
		create: { name: 'Child.txt', mediaType: 'text/plain', parentId: folderId },
	})
	const base = {
		ownerId,
		fileId: folderId,
		expectedVersion: 0,
		action: 'trash' as const,
		operationId: crypto.randomUUID(),
		writableParents: [folderId],
		canCreate: true,
	}
	const stub = env.FILE_STORE.get(
		env.FILE_STORE.idFromName(fileStoreName(ownerId)),
	)
	const denied = await runInDurableObject(stub, async (instance: FileStore) => {
		try {
			await instance.manage({ ...base, allowedIds: [folderId] })
			return null
		} catch (error) {
			return (error as Error).message
		}
	})
	expect(denied).toContain('Nothing was changed')
	expect(await store.list(ownerId)).toHaveLength(2)
	const access = { ...base, allowedIds: [folderId, childId] }
	await store.manage(access)
	expect(await store.list(ownerId)).toHaveLength(0)
	expect(await store.list(ownerId, true)).toHaveLength(2)
	await store.manage({
		...access,
		action: 'restore',
		expectedVersion: 1,
		operationId: crypto.randomUUID(),
	})
	expect(await store.list(ownerId)).toHaveLength(2)
	expect((await store.read(ownerId, childId)).content).toBe('Hello')
	await store.manage({
		...access,
		fileId: childId,
		action: 'trash',
		expectedVersion: 2,
		operationId: crypto.randomUUID(),
	})
	await store.manage({
		...access,
		expectedVersion: 2,
		operationId: crypto.randomUUID(),
	})
	await store.manage({
		...access,
		action: 'restore',
		expectedVersion: 3,
		operationId: crypto.randomUUID(),
	})
	expect((await store.list(ownerId)).map((file) => file.id)).toEqual([folderId])
})

test('repeated autosaves retain history beyond twenty revisions within the byte quota', async () => {
	const { store, input, ownerId } = workspace()
	await store.write(input)
	let baseRevisionId = input.writeId
	for (let i = 0; i < 25; i++) {
		const writeId = crypto.randomUUID()
		const result = await store.write({
			...input,
			create: undefined,
			baseRevisionId,
			writeId,
			content: `Edit ${i}`,
		})
		expect(result.ok).toBe(true)
		baseRevisionId = writeId
	}
	expect((await store.read(ownerId, input.fileId)).content).toBe('Edit 24')
	expect((await store.metadata(ownerId, input.fileId))?.revisions).toHaveLength(
		26,
	)
	expect(await store.write(input)).toMatchObject({
		ok: true,
		file: { content: 'Hello' },
	})
})

test('binary revisions larger than the text limit remain byte-exact and count toward quota', async () => {
	const { store, input, ownerId } = workspace()
	const content = btoa('z'.repeat(96 * 1024))
	const result = await store.write({
		...input,
		content,
		maxBytes: 200_000,
		create: { name: 'sample.wav', mediaType: 'audio/wav', encoding: 'base64' },
	})
	expect(result.ok).toBe(true)
	const file = await store.read(ownerId, input.fileId)
	expect(file.encoding).toBe('base64')
	expect(file.content).toBe(content)
	expect(file.revisions[0]!.bytes).toBe(96 * 1024)
})

test('the indexed catalog pages beyond the old pilot cap and keeps directory boundaries', async () => {
	const { store, input, ownerId } = workspace()
	for (let i = 0; i < 105; i++)
		await store.write({
			...input,
			fileId: crypto.randomUUID(),
			writeId: crypto.randomUUID(),
			content: '',
			create: {
				name: `File ${String(i).padStart(3, '0')}`,
				mediaType: 'text/plain',
			},
		})
	const first = await store.directoryPage(ownerId, null)
	expect(first.files).toHaveLength(100)
	const second = await store.directoryPage(ownerId, null, first.nextCursor!)
	expect(second.files).toHaveLength(5)
	expect(
		new Set([...first.files, ...second.files].map((file) => file.id)).size,
	).toBe(105)
	expect(second.nextCursor).toBeNull()
})

test('legacy revision arrays migrate without losing older history or quota accounting', async () => {
	const { store, input, ownerId } = workspace()
	const revisions = Array.from({ length: 125 }, (_, i) => ({
		id: crypto.randomUUID(),
		createdAt: new Date(1700000000000 + i).toISOString(),
		bytes: 5,
		sha256: 'legacy',
		author: 'Alice',
	}))
	const stub = env.FILE_STORE.get(
		env.FILE_STORE.idFromName(fileStoreName(ownerId)),
	)
	await runInDurableObject(stub, async (_instance, state) => {
		await state.storage.put(`file:${input.fileId}`, {
			id: input.fileId,
			name: 'Legacy.md',
			mediaType: 'text/markdown',
			revisionId: revisions.at(-1)!.id,
			revisions,
			createdAt: revisions[0]!.createdAt,
			updatedAt: revisions.at(-1)!.createdAt,
			createdBy: 'alice',
			createdProfileId: null,
		})
	})
	const metadata = await store.metadata(ownerId, input.fileId)
	expect(metadata?.revisions).toHaveLength(50)
	expect(metadata?.revisionCount).toBe(125)
	const history = [...metadata!.revisions]
	let cursor = metadata!.historyCursor
	while (cursor) {
		const page = await store.history(ownerId, input.fileId, cursor)
		history.push(...page.revisions)
		cursor = page.nextCursor
	}
	expect(new Set(history.map((revision) => revision.id)).size).toBe(125)
	expect(await store.revision(ownerId, input.fileId, revisions[0]!.id)).toEqual(
		revisions[0],
	)
	expect(
		(await store.exportMetadata(ownerId)).files[0]?.revisions,
	).toHaveLength(125)
	await expectWriteError(
		{
			...input,
			create: undefined,
			writeId: crypto.randomUUID(),
			baseRevisionId: revisions.at(-1)!.id,
			maxBytes: 625,
		},
		'included file storage limit',
	)
})

test('live storage quotas apply to new writes and preserve an admitted checkpoint', async () => {
	const { store, input, ownerId } = workspace()
	const other = workspace()
	await env.APP_DB.prepare(
		'INSERT INTO orgs (id, slug, created_at, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)',
	)
		.bind(ownerId, ownerId)
		.run()
	await env.APP_DB.prepare(
		'INSERT INTO file_storage_default_quota (id, included_bytes) VALUES (1, 4)',
	).run()
	try {
		await expectWriteError(input, 'included file storage limit')
		await expectWriteError(other.input, 'included file storage limit')

		await env.APP_DB.prepare(
			'INSERT INTO file_storage_quota_overrides (org_id, included_bytes) VALUES (?, 20)',
		)
			.bind(ownerId)
			.run()
		expect(await store.write(input)).toMatchObject({ ok: true })
		await expectWriteError(other.input, 'included file storage limit')
		await store.reserveCollaboration({
			ownerId,
			fileId: input.fileId,
			bytes: 6,
			maxBytes: input.maxBytes,
		})

		await env.APP_DB.prepare(
			'DELETE FROM file_storage_quota_overrides WHERE org_id = ?',
		)
			.bind(ownerId)
			.run()
		expect(await store.storageUsage(ownerId)).toMatchObject({
			includedBytes: 4,
			usedBytes: 5,
		})
		expect(
			await store.write({
				...input,
				create: undefined,
				writeId: crypto.randomUUID(),
				baseRevisionId: input.writeId,
				content: 'Hello',
				collaborationState: new Uint8Array([1]),
			}),
		).toMatchObject({ ok: true })
		await expectWriteError(
			{
				...input,
				fileId: crypto.randomUUID(),
				writeId: crypto.randomUUID(),
			},
			'included file storage limit',
		)
	} finally {
		await env.APP_DB.prepare('DELETE FROM file_storage_default_quota').run()
		await env.APP_DB.prepare('DELETE FROM orgs WHERE id = ?')
			.bind(ownerId)
			.run()
	}
})
