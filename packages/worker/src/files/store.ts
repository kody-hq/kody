import type { FileAssetSettings } from '#universal/file-assets.ts'
import { allStorageRows } from './storage-pages.ts'
import { providerObjectStore, storageEndpoint } from './object-storage.ts'
import {
	type FileStorageConfig,
	fileStorageConfigSchema,
	fileStorageQuotaError,
} from '#universal/file-storage.ts'
import { readFileStorageQuota } from './quota.ts'
import { FileCatalog } from './catalog.ts'
import { fileRoomRpc } from './room.ts'
import { fileBlobPrefix, fileBlobKey as blobKey } from './object-keys.ts'
export { fileBlobPrefix } from './object-keys.ts'
import {
	isWorkspaceContainer,
	workspaceDirectoryMediaType,
	readWorkspacePage,
	workspacePageMediaType,
} from '#universal/workspace-page.ts'
import { DurableObject } from 'cloudflare:workers'
import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { base64ToBytes, bytesToBase64 } from '@kody-internal/shared/base64.ts'
import { sha256Hex } from '@kody-internal/shared/sha256.ts'
import {
	type FileMetadata,
	type FileRevision,
	fileByteLimit,
	fileContentSchema,
	filePayloadSchema,
	fileIdSchema,
	fileNameSchema,
	fileMetadataSchema,
} from '#universal/files.ts'

type StoredFile = FileMetadata & {
	lastOperationFingerprint?: string
	lastOperationId?: string
	trashBatch?: string
	createdBy: string
	createdProfileId: string | null
}
type PendingObject = {
	storageId?: string
	key: string
	bytes: number
	fileId: string
	writeId: string
	sha256: string
	checkpointBytes?: number
}
export type FileStoreRpc = Pick<
	FileStore,
	| 'objectProvider'
	| 'storageStatus'
	| 'storageUsage'
	| 'configureStorage'
	| 'history'
	| 'revision'
	| 'directoryPage'
	| 'setPublicLink'
	| 'assetSettings'
	| 'setAssetSettings'
	| 'publicLinkMatches'
	| 'hasPublicLink'
	| 'publicLinkSecret'
	| 'readCollaborationCheckpoint'
	| 'activateCollaboration'
	| 'reserveCollaboration'
	| 'releaseCollaboration'
	| 'manage'
	| 'list'
	| 'metadata'
	| 'read'
	| 'write'
	| 'remove'
	| 'inventory'
	| 'purge'
	| 'exportMetadata'
>

function publicMetadata(file: StoredFile): FileMetadata {
	const {
		createdBy: _creator,
		createdProfileId: _profile,
		lastOperationId: _operation,
		lastOperationFingerprint: _fingerprint,
		trashBatch: _batch,
		...metadata
	} = file
	return metadata
}

/** One org's catalog and quota coordinator. Contents are immutable R2 objects. */
export class FileStore extends DurableObject<Env> {
	private catalogIndex?: FileCatalog<StoredFile>
	private catalog() {
		return (this.catalogIndex ??= new FileCatalog<StoredFile>(this.ctx.storage))
	}
	private async serial<T>(operation: () => Promise<T>): Promise<T> {
		const result = await this.ctx.blockConcurrencyWhile(async () => {
			try {
				return { ok: true as const, value: await operation() }
			} catch (error) {
				return {
					ok: false as const,
					message:
						error instanceof Error ? error.message : 'File operation failed.',
				}
			}
		})
		if (!result.ok) throw new Error(result.message)
		return result.value
	}
	private async scope(ownerId: OwnerId) {
		const stored = await this.ctx.storage.get<string>('owner')
		if (stored && stored !== ownerId)
			throw new Error('File storage owner mismatch.')
		if (!stored) await this.ctx.storage.put('owner', ownerId)
		await this.catalog().initialize()
	}
	private async files() {
		return this.catalog().all()
	}
	async history(ownerId: OwnerId, fileId: string, cursor?: string) {
		await this.scope(ownerId)
		if (!this.catalog().get(fileId)) throw new Error('File not found.')
		return this.catalog().history(fileId, cursor)
	}
	async revision(ownerId: OwnerId, fileId: string, revisionId: string) {
		await this.scope(ownerId)
		return this.catalog().revision(fileId, revisionId) ?? null
	}
	async directoryPage(
		ownerId: OwnerId,
		parentId: string | null,
		cursor?: string,
		includeTrash = false,
	) {
		await this.scope(ownerId)
		return this.catalog().page(parentId, cursor, includeTrash)
	}
	private async provider(id?: string) {
		if (!id) return null
		const config = await this.ctx.storage.get<FileStorageConfig>(
			`provider:${id}`,
		)
		if (!config) throw new Error('The file storage connection is missing.')
		return config
	}
	private async objects(ownerId: OwnerId, id?: string) {
		return providerObjectStore(this.env, ownerId, await this.provider(id))
	}
	async storageUsage(ownerId: OwnerId) {
		await this.scope(ownerId)
		const { includedBytes } = await readFileStorageQuota(
			this.env.APP_DB,
			Number(this.env.FILES_INCLUDED_BYTES ?? 0),
			ownerId,
		)
		return {
			includedBytes,
			usedBytes: this.catalog().usedBytes(),
			external: Boolean(await this.ctx.storage.get('active-provider')),
		}
	}
	async storageStatus(ownerId: OwnerId) {
		await this.scope(ownerId)
		const providers = Array.from(
			(
				await allStorageRows<FileStorageConfig>(this.ctx.storage, 'provider:')
			).values(),
		)
		const activeId = await this.ctx.storage.get<string>('active-provider')
		return { active: await this.provider(activeId), providers }
	}
	async configureStorage(ownerId: OwnerId, config: FileStorageConfig | null) {
		return this.serial(async () => {
			await this.scope(ownerId)
			if (!config) {
				await this.ctx.storage.delete('active-provider')
				return this.storageStatus(ownerId)
			}
			const parsed = fileStorageConfigSchema.parse(config)
			const existing = await this.ctx.storage.get<FileStorageConfig>(
				`provider:${parsed.id}`,
			)
			parsed.endpoint = storageEndpoint(parsed.endpoint).origin
			if (
				existing &&
				(new URL(existing.endpoint).origin !== parsed.endpoint ||
					existing.bucket !== parsed.bucket ||
					existing.region !== parsed.region)
			)
				throw new Error(
					'An existing storage connection cannot change its bucket or endpoint. Create a new connection.',
				)

			const store = await providerObjectStore(this.env, ownerId, parsed)
			const key = `${fileBlobPrefix(ownerId)}connection-check/${parsed.id}`
			const bytes = new TextEncoder().encode(parsed.id)
			await this.ctx.storage.put({
				[`provider-probe-config:${parsed.id}`]: parsed,
				[`provider-probe:${parsed.id}`]: true,
			})
			try {
				await store.put(key, bytes)
				const result = await store.get(key)
				if (
					!result ||
					(await sha256Hex(await result.arrayBuffer())) !==
						(await sha256Hex(bytes))
				)
					throw new Error('Storage verification failed.')
			} finally {
				try {
					await store.delete(key)
					await this.ctx.storage.delete([
						`provider-probe:${parsed.id}`,
						`provider-probe-config:${parsed.id}`,
					])
				} catch (error) {
					await this.ctx.storage.setAlarm(Date.now() + 5000)
					throw error
				}
			}
			await this.ctx.storage.put({
				[`provider:${parsed.id}`]: parsed,
				'active-provider': parsed.id,
			})
			return this.storageStatus(ownerId)
		})
	}
	async objectProvider(ownerId: OwnerId, key: string) {
		await this.scope(ownerId)
		const prefix = fileBlobPrefix(ownerId)
		if (!key.startsWith(prefix)) throw new Error('File storage owner mismatch.')
		const [fileId, revisionId, suffix, ...extra] = key
			.slice(prefix.length)
			.split('/')
		if (!fileId || !revisionId || extra.length || (suffix && suffix !== 'yjs'))
			throw new Error('Invalid file object key.')
		const revision = this.catalog().revision(fileId, revisionId)
		const pending = revision
			? undefined
			: await this.ctx.storage.get<PendingObject>(`pending:${revisionId}`)
		if (!revision && (!pending || pending.fileId !== fileId))
			throw new Error('File revision not found.')
		return this.provider(revision?.storageId ?? pending?.storageId)
	}
	async assetSettings(ownerId: OwnerId, fileId: string) {
		await this.scope(ownerId)
		return (
			(await this.ctx.storage.get<FileAssetSettings>(
				`asset-settings:${fileId}`,
			)) ?? null
		)
	}

	async setAssetSettings(
		ownerId: OwnerId,
		fileId: string,
		settings: FileAssetSettings,
	) {
		return this.serial(async () => {
			await this.scope(ownerId)
			const file = await this.metadata(ownerId, fileId)
			if (!file || file.trashedAt) throw new Error('File not found.')
			await this.ctx.storage.put(`asset-settings:${fileId}`, settings)
		})
	}

	async setPublicLink(
		ownerId: OwnerId,
		fileId: string,
		tokenHash: string | null,
		sealedToken?: string,
	) {
		return this.serial(async () => {
			await this.scope(ownerId)
			const file = await this.metadata(ownerId, fileId)
			if (!file || file.trashedAt) throw new Error('File not found.')
			if (tokenHash)
				await this.ctx.storage.put(
					`public:${fileId}`,
					sealedToken ? { hash: tokenHash, sealedToken } : tokenHash,
				)
			else await this.ctx.storage.delete(`public:${fileId}`)
		})
	}
	async publicLinkMatches(ownerId: OwnerId, fileId: string, tokenHash: string) {
		await this.scope(ownerId)
		const expected = await this.ctx.storage.get<
			string | { hash: string; sealedToken: string }
		>(`public:${fileId}`)
		return (
			!!expected &&
			(typeof expected === 'string' ? expected : expected.hash) === tokenHash
		)
	}
	async publicLinkSecret(ownerId: OwnerId, fileId: string) {
		await this.scope(ownerId)
		const record = await this.ctx.storage.get<
			string | { hash: string; sealedToken: string }
		>(`public:${fileId}`)
		return record && typeof record !== 'string' ? record.sealedToken : null
	}

	async hasPublicLink(ownerId: OwnerId, fileId: string) {
		await this.scope(ownerId)
		return !!(await this.ctx.storage.get<string>(`public:${fileId}`))
	}

	async readCollaborationCheckpoint(ownerId: OwnerId, fileId: string) {
		await this.scope(ownerId)
		const file = await this.metadata(ownerId, fileId)
		const revision = file?.revisionId
			? this.catalog().revision(fileId, file.revisionId)
			: undefined
		if (!revision?.collaborationSha256) return null
		const object = await (
			await this.objects(ownerId, revision.storageId)
		).get(`${blobKey(ownerId, fileId, revision.id)}/yjs`)
		if (!object) throw new Error('Shared checkpoint is missing.')
		const bytes = new Uint8Array(await object.arrayBuffer())
		if ((await sha256Hex(bytes)) !== revision.collaborationSha256)
			throw new Error('Shared checkpoint integrity check failed.')
		return bytes
	}

	async activateCollaboration(ownerId: OwnerId, fileId: string) {
		return this.serial(async () => {
			await this.scope(ownerId)
			const file = this.catalog().get(fileId)
			if (!file || file.trashedAt) throw new Error('File not found.')
			if (!file.collaboration)
				await this.ctx.storage.transaction(async (tx) => {
					this.catalog().put({ ...file, collaboration: true })
					await tx.put(`room:${fileId}`, true)
				})
		})
	}

	async reserveCollaboration(input: {
		ownerId: OwnerId
		fileId: string
		bytes: number
		maxBytes: number
	}) {
		return this.serial(async () => {
			await this.scope(input.ownerId)
			const external = await this.ctx.storage.get<string>('active-provider')
			if (external) {
				await this.ctx.storage.delete(`reservation:${input.fileId}`)
				await this.ctx.storage.put(
					`reservation-provider:${input.fileId}`,
					external,
				)
				return
			}
			const reservations = await this.ctx.storage.list<number>({
				prefix: 'reservation:',
			})
			const used = this.catalog().usedBytes()
			const pending = await this.ctx.storage.list<PendingObject>({
				prefix: 'pending:',
			})
			const pendingBytes = Array.from(pending.values()).reduce(
				(sum, item) => sum + (item.storageId ? 0 : item.bytes),
				0,
			)
			const other = Array.from(reservations.entries()).reduce(
				(total, [key, bytes]) =>
					total + (key === `reservation:${input.fileId}` ? 0 : bytes),
				0,
			)
			const { includedBytes } = await readFileStorageQuota(
				this.env.APP_DB,
				input.maxBytes,
				input.ownerId,
			)
			if (
				!Number.isSafeInteger(input.bytes) ||
				input.bytes < 0 ||
				includedBytes <= 0 ||
				used + other + pendingBytes + input.bytes > includedBytes
			)
				throw new Error(fileStorageQuotaError)
			await this.ctx.storage.put({
				[`reservation:${input.fileId}`]: input.bytes,
				[`reservation-provider:${input.fileId}`]: null,
			})
		})
	}
	async releaseCollaboration(ownerId: OwnerId, fileId: string) {
		await this.scope(ownerId)
		await this.ctx.storage.delete([
			`reservation:${fileId}`,
			`reservation-provider:${fileId}`,
		])
	}

	async list(ownerId: OwnerId, includeTrash = false) {
		await this.scope(ownerId)
		return (await this.files())
			.filter(
				(file) => file.revisionId !== null && (includeTrash || !file.trashedAt),
			)
			.map(publicMetadata)
			.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
	}
	async metadata(ownerId: OwnerId, fileId: string) {
		await this.scope(ownerId)
		const file = this.catalog().get(fileId)
		return file ? publicMetadata(file) : null
	}
	async read(ownerId: OwnerId, fileId: string, revisionId?: string) {
		await this.scope(ownerId)
		const file = this.catalog().get(fileId)
		if (!file?.revisionId || file.trashedAt) throw new Error('File not found.')
		const revision = this.catalog().revision(
			fileId,
			revisionId ?? file.revisionId,
		)
		if (!revision) throw new Error('File revision not found.')
		const object = await (
			await this.objects(ownerId, revision.storageId)
		).get(blobKey(ownerId, fileId, revision.id))
		if (!object)
			throw new Error(
				'File contents are unavailable. Your file history has been preserved.',
			)
		const data = await object.arrayBuffer()
		const content =
			file.encoding === 'base64'
				? bytesToBase64(new Uint8Array(data))
				: new TextDecoder('utf-8', { ignoreBOM: true }).decode(data)
		if ((await sha256Hex(data)) !== revision.sha256)
			throw new Error('File integrity check failed.')
		return {
			...publicMetadata(file),
			revisions: file.revisions.some((r) => r.id === revision.id)
				? file.revisions
				: [revision, ...file.revisions],
			revisionId: revision.id,
			content,
		}
	}
	async write(input: {
		ownerId: OwnerId
		fileId: string
		writeId: string
		baseRevisionId: string | null
		content: string
		collaborationState?: Uint8Array
		actorId: string
		profileId: string | null
		author: string
		maxBytes: number
		create?: {
			name: string
			mediaType: FileMetadata['mediaType']
			encoding?: FileMetadata['encoding']
			parentId?: string
		}
	}) {
		return this.serial(async () => {
			await this.scope(input.ownerId)
			fileIdSchema.parse(input.fileId)
			fileIdSchema.parse(input.writeId)
			if (await this.ctx.storage.get(`deleted:${input.fileId}`))
				throw new Error('This file has been deleted. Create a new file id.')
			if (input.create) {
				input.create.name = fileNameSchema.parse(input.create.name)
				fileMetadataSchema.shape.mediaType.parse(input.create.mediaType)
			}
			let file = this.catalog().get(input.fileId)
			const encoding =
				file?.encoding ?? (file ? 'utf8' : (input.create?.encoding ?? 'utf8'))
			if (file?.trashedAt)
				throw new Error('This file is in trash. Restore it before editing.')
			if (input.create && (input.create.encoding ?? 'utf8') !== encoding)
				throw new Error('This file id is already in use.')
			const content =
				encoding === 'base64'
					? filePayloadSchema.parse(input.content)
					: fileContentSchema.parse(input.content)
			const mediaType = file?.mediaType ?? input.create?.mediaType
			if (
				mediaType === workspacePageMediaType &&
				(encoding !== 'utf8' || !readWorkspacePage(content))
			)
				throw new Error('Invalid workspace page contents.')
			if (
				mediaType === workspaceDirectoryMediaType &&
				(encoding !== 'utf8' || content !== '')
			)
				throw new Error(
					'Invalid directory contents. Directories contain items, not document text.',
				)
			if (!file && input.create?.parentId) {
				const parentId = fileIdSchema.parse(input.create.parentId)
				const parent = this.catalog().get(parentId)
				if (
					!parent?.revisionId ||
					parent.trashedAt ||
					!isWorkspaceContainer(parent.mediaType)
				)
					throw new Error('Parent page or directory not found.')
			}
			let payload: Uint8Array<ArrayBuffer>
			try {
				payload =
					encoding === 'base64'
						? new Uint8Array(base64ToBytes(content))
						: new TextEncoder().encode(content)
			} catch {
				throw new Error('File contents must be valid base64.')
			}
			const bytes = payload.byteLength
			if (bytes > fileByteLimit)
				throw new Error('Files may contain at most 16 MiB.')
			const hash = await sha256Hex(payload)
			if (
				input.create &&
				file &&
				(file.createdBy !== input.actorId ||
					file.createdProfileId !== input.profileId ||
					file.parentId !== input.create.parentId ||
					file.mediaType !== input.create.mediaType)
			)
				throw new Error('This file id is already in use.')
			const existing = this.catalog().revision(input.fileId, input.writeId)
			if (existing) {
				if (
					existing.sha256 !== hash ||
					existing.collaborationSha256 !==
						(input.collaborationState
							? await sha256Hex(new Uint8Array(input.collaborationState))
							: undefined)
				)
					throw new Error(
						'This write id was already used for different content.',
					)
				return {
					ok: true as const,
					file: await this.read(input.ownerId, input.fileId, input.writeId),
				}
			}
			if (
				input.create &&
				file &&
				(file.revisionId !== null ||
					file.createdBy !== input.actorId ||
					file.createdProfileId !== input.profileId)
			)
				throw new Error('This file id is already in use.')
			if (!file && !input.create) throw new Error('File not found.')
			if (file && file.revisionId !== input.baseRevisionId) {
				const current = await this.read(input.ownerId, input.fileId)
				return {
					ok: false as const,
					code: 'revision_conflict' as const,
					current_revision_id: current.revisionId,
					current: current.content,
					proposed: content,
				}
			}

			const pending = await this.ctx.storage.list<PendingObject>({
				prefix: 'pending:',
			})
			const checkpointBytes = input.collaborationState?.byteLength ?? 0
			if (checkpointBytes > 1024 * 1024)
				throw new Error('Shared checkpoint is too large.')
			const retainedBytes = bytes + checkpointBytes
			const intent = pending.get(`pending:${input.writeId}`)
			const reservedProvider = input.collaborationState
				? await this.ctx.storage.get<string | null>(
						`reservation-provider:${input.fileId}`,
					)
				: undefined
			const storageId = intent
				? intent.storageId
				: reservedProvider === undefined
					? await this.ctx.storage.get<string>('active-provider')
					: (reservedProvider ?? undefined)
			if (
				intent &&
				(intent.fileId !== input.fileId ||
					intent.bytes !== retainedBytes ||
					intent.sha256 !== hash)
			)
				throw new Error('This write id belongs to another upload.')
			if (!intent && pending.size >= 64)
				throw new Error(
					'Too many incomplete uploads. Retry an existing upload or delete its file.',
				)
			if (!storageId && !intent) {
				const reservations = await this.ctx.storage.list<number>({
					prefix: 'reservation:',
				})
				const reservationKey = `reservation:${input.fileId}`
				const checkpointReserved =
					input.collaborationState &&
					reservedProvider === null &&
					(reservations.get(reservationKey) ?? 0) >= retainedBytes
				if (!checkpointReserved) {
					const { includedBytes } = await readFileStorageQuota(
						this.env.APP_DB,
						input.maxBytes,
						input.ownerId,
					)
					const used =
						this.catalog().usedBytes() +
						Array.from(reservations.values()).reduce(
							(total, bytes) => total + bytes,
							0,
						) +
						Array.from(pending.values()).reduce(
							(total, item) => total + (item.storageId ? 0 : item.bytes),
							0,
						)
					if (includedBytes <= 0 || used + retainedBytes > includedBytes)
						throw new Error(fileStorageQuotaError)
				}
			}
			const now = new Date().toISOString()
			file ??= {
				id: input.fileId,
				name: input.create!.name,
				mediaType: input.create!.mediaType,
				...(input.create!.parentId ? { parentId: input.create!.parentId } : {}),
				...(encoding === 'base64' ? { encoding } : {}),
				revisionId: null,
				revisions: [],
				createdAt: now,
				updatedAt: now,
				createdBy: input.actorId,
				createdProfileId: input.profileId,
			}
			const key = blobKey(input.ownerId, input.fileId, input.writeId)
			this.catalog().put(file)
			await this.ctx.storage.put({
				[`pending:${input.writeId}`]: {
					key,
					storageId,
					bytes: retainedBytes,
					checkpointBytes,
					fileId: input.fileId,
					writeId: input.writeId,
					sha256: hash,
				} satisfies PendingObject,
			})
			const destination = await this.objects(input.ownerId, storageId)
			await destination.put(key, payload, {
				httpMetadata: { contentType: `${file.mediaType}` },
			})
			const uploaded = await destination.get(key)
			if (!uploaded || (await sha256Hex(await uploaded.arrayBuffer())) !== hash)
				throw new Error(
					'File upload could not be verified. Retry with the same write id.',
				)
			let checkpointHash: string | undefined
			if (input.collaborationState) {
				checkpointHash = await sha256Hex(
					new Uint8Array(input.collaborationState),
				)
				const checkpointKey = `${key}/yjs`
				await destination.put(checkpointKey, input.collaborationState, {
					httpMetadata: { contentType: 'application/octet-stream' },
				})
				const checkpoint = await destination.get(checkpointKey)
				if (
					!checkpoint ||
					(await sha256Hex(await checkpoint.arrayBuffer())) !== checkpointHash
				)
					throw new Error('Shared checkpoint could not be verified.')
			}
			const revision: FileRevision = {
				id: input.writeId,
				...(storageId ? { storageId } : {}),
				...(checkpointHash
					? {
							collaborationBytes: checkpointBytes,
							collaborationSha256: checkpointHash,
						}
					: {}),
				bytes,
				sha256: hash,
				createdAt: now,
				author: input.author,
			}
			const next = {
				...file,
				revisionId: input.writeId,
				updatedAt: now,
				revisions: [...file.revisions, revision],
			}
			await this.ctx.storage.transaction(async (transaction) => {
				this.catalog().put(next)
				await transaction.delete(`pending:${input.writeId}`)
			})
			return {
				ok: true as const,
				file: {
					...publicMetadata(this.catalog().get(input.fileId)!),
					content: encoding === 'base64' ? bytesToBase64(payload) : content,
				},
			}
		})
	}
	async manage(input: {
		ownerId: OwnerId
		fileId: string
		operationId: string
		expectedVersion: number
		action: 'rename' | 'move' | 'trash' | 'restore' | 'access'
		name?: string
		parentId?: string | null
		accessMode?: 'inherit' | 'restricted'
		allowedIds: string[]
		writableParents: string[]
		canCreate: boolean
	}) {
		return this.serial(async () => {
			await this.scope(input.ownerId)
			fileIdSchema.parse(input.operationId)
			const files = await this.files()
			const byId = new Map(files.map((file) => [file.id, file]))
			const file = byId.get(input.fileId)
			if (!file?.revisionId) throw new Error('File not found.')
			const fingerprint = JSON.stringify([
				input.action,
				input.expectedVersion,
				input.name ?? null,
				input.parentId ?? null,
				input.accessMode ?? null,
			])
			if (file.lastOperationId === input.operationId) {
				if (file.lastOperationFingerprint !== fingerprint)
					throw new Error(
						'This file operation ID was used for a different change.',
					)
				return publicMetadata(file)
			}
			if ((file.metadataVersion ?? 0) !== input.expectedVersion)
				throw new Error('This file changed. Refresh before trying again.')
			const allowed = new Set(input.allowedIds)
			if (!allowed.has(file.id))
				throw new Error('This file operation is not permitted.')
			const descendants = new Set([file.id])
			for (let pass = 0; pass < files.length; pass++) {
				const before = descendants.size
				for (const item of files)
					if (item.parentId && descendants.has(item.parentId))
						descendants.add(item.id)
				if (before === descendants.size) break
			}
			const now = new Date().toISOString()
			const updates: Record<string, StoredFile> = {}
			const update = (item: StoredFile) => {
				const next = {
					...item,
					metadataVersion: (item.metadataVersion ?? 0) + 1,
					lastOperationId: input.operationId,
					lastOperationFingerprint: fingerprint,
					updatedAt: now,
				}
				updates['file:' + item.id] = next
				return next
			}
			if (input.action === 'access') {
				if (!input.accessMode) throw new Error('Choose an access policy.')
				update(file).accessMode = input.accessMode
			} else if (input.action === 'rename' || input.action === 'move') {
				if (file.trashedAt)
					throw new Error('This file is in trash. Restore it first.')
				if (input.action === 'rename')
					update(file).name = fileNameSchema.parse(input.name)
				else {
					const parent = input.parentId ? byId.get(input.parentId) : undefined
					if (
						input.parentId &&
						(!parent?.revisionId ||
							parent.trashedAt ||
							!isWorkspaceContainer(parent.mediaType))
					)
						throw new Error('Parent page or directory not found.')
					if (input.parentId && descendants.has(input.parentId))
						throw new Error(
							'This file cannot move into itself or its descendants.',
						)
					if (file.parentId && !input.writableParents.includes(file.parentId))
						throw new Error(
							'This file cannot be moved out of its current parent.',
						)
					if (
						input.parentId
							? !input.writableParents.includes(input.parentId)
							: !input.canCreate
					)
						throw new Error('This file cannot be moved to that destination.')
					const next = update(file)
					if (input.parentId) next.parentId = input.parentId
					else delete next.parentId
				}
			} else {
				if (input.action === 'restore' && !file.trashedAt)
					return publicMetadata(file)
				if (input.action === 'trash' && file.trashedAt)
					return publicMetadata(file)
				const affected = files.filter(
					(item) =>
						descendants.has(item.id) &&
						(input.action === 'trash'
							? !item.trashedAt
							: item.trashBatch === file.trashBatch),
				)
				if (affected.some((item) => !allowed.has(item.id)))
					throw new Error(
						'This file contains items you cannot manage. Nothing was changed.',
					)
				for (const item of affected) {
					const next = update(item)
					if (input.action === 'trash') {
						next.trashedAt = now
						next.trashBatch = input.operationId
					} else {
						delete next.trashedAt
						delete next.trashBatch
					}
				}
				if (input.action === 'restore' && file.parentId) {
					const parent = byId.get(file.parentId)
					if (
						parent &&
						!parent.trashedAt &&
						!input.writableParents.includes(parent.id)
					)
						throw new Error(
							'This file cannot be restored into its original parent.',
						)
					if (!parent || parent.trashedAt) {
						if (!input.canCreate)
							throw new Error(
								'This file requires workspace create permission to restore at the root.',
							)
						delete updates['file:' + file.id]!.parentId
					}
				}
			}
			await this.ctx.storage.transaction(async () => {
				for (const next of Object.values(updates)) this.catalog().put(next)
			})
			return publicMetadata(updates['file:' + file.id] ?? file)
		})
	}

	async remove(ownerId: OwnerId, fileId: string) {
		const result = await this.serial(async () => {
			await this.scope(ownerId)
			const file = this.catalog().get(fileId)
			if (!file) return { removed: false, collaboration: false }
			if ((await this.files()).some((child) => child.parentId === fileId))
				throw new Error(
					'This file contains other items. Remove its contents first.',
				)
			await this.deleteExternalObjects(ownerId, fileId)
			await this.deletePrefix(fileBlobPrefix(ownerId, fileId))
			const pending = await this.ctx.storage.list<PendingObject>({
				prefix: 'pending:',
			})
			for (const [key, object] of pending)
				if (object.fileId === fileId) await this.ctx.storage.delete(key)
			await this.ctx.storage.put({
				[`deleted:${fileId}`]: true,
				[`delete-room:${fileId}`]: true,
			})
			this.catalog().remove(fileId)
			await this.ctx.storage.delete([
				`public:${fileId}`,
				`asset-settings:${fileId}`,
			])
			return { removed: true, collaboration: !!file.collaboration }
		})
		if (result.removed) {
			try {
				await fileRoomRpc(this.env, ownerId, fileId).purge(ownerId, fileId)
				await this.ctx.storage.delete([
					`delete-room:${fileId}`,
					`room:${fileId}`,
				])
			} catch {
				await this.ctx.storage.setAlarm(Date.now() + 5000)
			}
		}
		return result.removed
	}
	private async deleteExternalObjects(ownerId: OwnerId, fileId?: string) {
		if (!fileId) await this.cleanupStorageProbes(ownerId)

		const refs = this.catalog()
			.allRevisions()
			.filter(
				(row) => (!fileId || row.fileId === fileId) && row.revision.storageId,
			)
			.map((row) => ({
				key: blobKey(ownerId, row.fileId, row.revision.id),
				storageId: row.revision.storageId!,
				checkpoint: !!row.revision.collaborationBytes,
			}))
		const pending = await this.ctx.storage.list<PendingObject>({
			prefix: 'pending:',
		})
		for (const item of pending.values())
			if (item.storageId && (!fileId || item.fileId === fileId))
				refs.push({
					key: item.key,
					storageId: item.storageId,
					checkpoint: !!item.checkpointBytes,
				})
		for (const ref of refs) {
			const receipt = `external-deleted:${ref.key}`
			if (await this.ctx.storage.get(receipt)) continue
			const store = await this.objects(ownerId, ref.storageId)
			await store.delete(ref.checkpoint ? [ref.key, `${ref.key}/yjs`] : ref.key)
			await this.ctx.storage.put(receipt, true)
		}
	}
	private async deletePrefix(prefix: string) {
		let cursor: string | undefined
		do {
			const page = await this.env.FILE_BLOBS!.list({
				prefix,
				limit: 500,
				...(cursor ? { cursor } : {}),
			})
			if (page.objects.length)
				await this.env.FILE_BLOBS!.delete(
					page.objects.map((object) => object.key),
				)
			cursor = page.truncated ? page.cursor : undefined
		} while (cursor)
	}
	async inventory(ownerId: OwnerId) {
		await this.scope(ownerId)
		const pending = await this.ctx.storage.list<PendingObject>({
			prefix: 'pending:',
		})
		return Array.from(
			new Set([
				...this.catalog()
					.allRevisions()
					.flatMap(({ fileId, revision }) => {
						const key = blobKey(ownerId, fileId, revision.id)
						return revision.collaborationBytes ? [key, `${key}/yjs`] : [key]
					}),
				...Array.from(pending.values()).flatMap((object) =>
					object.checkpointBytes
						? [object.key, `${object.key}/yjs`]
						: [object.key],
				),
			]),
		).sort()
	}
	async exportMetadata(ownerId: OwnerId) {
		await this.scope(ownerId)
		const history = this.catalog().allRevisions()
		const files = (await this.files()).map((file) => ({
			...publicMetadata(file),
			revisions: history
				.filter((row) => row.fileId === file.id)
				.map((row) => row.revision),
		}))
		const collaboration = await Promise.all(
			files
				.filter((file) => file.collaboration)
				.map((file) =>
					fileRoomRpc(this.env, ownerId, file.id).exportMetadata(
						ownerId,
						file.id,
					),
				),
		)
		const publicLinks = Array.from(
			await this.ctx.storage.list<
				string | { hash: string; sealedToken: string }
			>({ prefix: 'public:' }),
		)
		const storage = await this.storageStatus(ownerId)
		return {
			files,
			...(storage.providers.length ? { storage } : {}),
			...(publicLinks.length ? { publicLinks } : {}),
			...(collaboration.length ? { collaboration } : {}),
		}
	}
	private async cleanupStorageProbes(ownerId: OwnerId) {
		const probes = await allStorageRows<boolean>(
			this.ctx.storage,
			'provider-probe:',
		)
		for (const key of probes.keys()) {
			const id = key.slice('provider-probe:'.length)
			const candidate = await this.ctx.storage.get<FileStorageConfig>(
				`provider-probe-config:${id}`,
			)
			const store = candidate
				? await providerObjectStore(this.env, ownerId, candidate)
				: await this.objects(ownerId, id)
			await store.delete(`${fileBlobPrefix(ownerId)}connection-check/${id}`)
			await this.ctx.storage.delete([key, `provider-probe-config:${id}`])
		}
	}
	async alarm() {
		const owner = await this.ctx.storage.get<OwnerId>('owner')
		if (!owner) return
		try {
			await this.cleanupStorageProbes(owner)
		} catch {
			await this.ctx.storage.setAlarm(Date.now() + 5000)
		}
		const pending = await this.ctx.storage.list<boolean>({
			prefix: 'delete-room:',
		})
		for (const key of pending.keys()) {
			const fileId = key.slice('delete-room:'.length)
			try {
				await fileRoomRpc(this.env, owner, fileId).purge(owner, fileId)
				await this.ctx.storage.delete([key, `room:${fileId}`])
			} catch {
				await this.ctx.storage.setAlarm(Date.now() + 5000)
			}
		}
	}
	async purge(ownerId: OwnerId) {
		await this.scope(ownerId)
		const rooms = await this.ctx.storage.list<boolean>({ prefix: 'room:' })
		const pending = await this.ctx.storage.list<boolean>({
			prefix: 'delete-room:',
		})
		const ids = new Set([
			...(await this.files()).map((file) => file.id),
			...Array.from(rooms.keys(), (key) => key.slice(5)),
			...Array.from(pending.keys(), (key) => key.slice('delete-room:'.length)),
		])
		// Keep the recovery index until every room has been purged. Never hold the
		// catalog lock while a room may still be awaiting its catalog checkpoint.
		for (const fileId of ids)
			await fileRoomRpc(this.env, ownerId, fileId).purge(ownerId, fileId)
		return this.serial(async () => {
			await this.deleteExternalObjects(ownerId)
			await this.deletePrefix(fileBlobPrefix(ownerId))
			await this.ctx.storage.deleteAll()
			this.catalogIndex = undefined
			return { purged: true }
		})
	}
}
