import { fileObjectReader } from './object-storage.ts'
import {
	fileCollaborationEnabled,
	fileEffectivePermissions,
} from './feature.ts'
import { fileTreePermission, loadFileAncestors } from './tree-access.ts'
import { fileRoomRpc, type FileSessionProof } from './room.ts'
import { type CommentCommand } from '#universal/file-collaboration.ts'
import { parseFileRange } from '#universal/file-assets.ts'
import { fileBlobKey } from './object-keys.ts'
import {
	type pagePatchSchema,
	patchWorkspacePage,
	workspacePageMediaType,
	workspaceDirectoryMediaType,
} from '#universal/workspace-page.ts'
import { type z } from 'zod'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import {
	requireMcpRequest,
	requireMcpUser,
} from '#mcp/capabilities/meta/require-user.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import { checkPermission } from '#worker/authorization/authorize.ts'
import { type OrgPermission } from '@kody-internal/shared/org-permissions.ts'
import { withAccountWriteLease } from '#worker/account/deletion-state.ts'
import { grantCreatorAccess } from '#worker/orgs/creator-access.ts'
import {
	optionalOrgAuditWriter,
	recordCommittedOrgAuditEvent,
} from '#worker/orgs/org-audit.ts'
import {
	type FileMetadata,
	type fileCreateSchema,
	type fileWriteSchema,
	type fileManageSchema,
} from '#universal/files.ts'
import { fileStoreRpc } from './client.ts'

async function fileOperation<T>(run: () => Promise<T>): Promise<T> {
	try {
		return await run()
	} catch (error) {
		if (
			error instanceof Error &&
			/^(This (workspace|file|write)|Too many incomplete uploads|Files may contain|File (contents must|not found|revision not found)|Invalid workspace page|Invalid directory|Parent page)/.test(
				error.message,
			)
		)
			throw new McpCallerError(error.message, { cause: error })
		throw error
	}
}

async function scope(ctx: CapabilityContext, focusFileId?: string) {
	requireMcpUser(ctx.callerContext)
	const request = requireMcpRequest(ctx.callerContext)
	if (!request.actor) throw new McpCallerError('Sign in to open files.')
	const access = await fileEffectivePermissions(ctx.env, request)
	const store = fileStoreRpc(ctx.env, request.org.id)
	const canRead =
		checkPermission(access, 'file:read').allowed ||
		[...access.resourcePermissions].some(
			([key, permissions]) =>
				key.startsWith('file:') && permissions.has('file:read'),
		)
	const files = !canRead
		? new Map<string, FileMetadata>()
		: focusFileId
			? await loadFileAncestors(
					(id) => store.metadata(request.org.id, id),
					focusFileId,
				)
			: new Map(
					(await store.list(request.org.id, true)).map((file) => [
						file.id,
						file,
					]),
				)
	const holds = (permission: OrgPermission, id?: string) =>
		id && permission.startsWith('file:')
			? fileTreePermission(access, files, permission, id)
			: checkPermission(access, permission).allowed
	const require = (permission: OrgPermission, id?: string) => {
		if (!holds(permission, id))
			throw new McpCallerError('You do not have access to this file operation.')
	}

	return {
		request,
		env: ctx.env,
		store,
		files,
		holds,
		require,
		accessFor: (id: string) => ({
			write: holds('file:write', id),
			comment: holds('file:comment', id) || holds('file:write', id),
			delete: holds('file:delete', id),
			manage_access: holds('file:manage_access', id),
		}),
	}
}

export async function listFiles(ctx: CapabilityContext, includeTrash = false) {
	const s = await scope(ctx)
	const files = (await s.store.list(s.request.org.id, includeTrash)).filter(
		(file) => s.holds('file:read', file.id),
	)
	return {
		files: files.map((file) => ({ ...file, access: s.accessFor(file.id) })),
		can_create: s.holds('file:create'),
		writes_enabled:
			Number(ctx.env.FILES_INCLUDED_BYTES ?? 0) > 0 ||
			!!(await s.store.storageStatus(s.request.org.id)).active,
	}
}
async function describeFile(
	s: Awaited<ReturnType<typeof scope>>,
	fileId: string,
	revisionId?: string,
) {
	s.require('file:read', fileId)
	const initial = s.files.get(fileId)
	if (initial?.collaboration)
		await fileRoomRpc(s.env, s.request.org.id, fileId).flushForRead(
			s.request,
			fileId,
		)
	let file = initial?.collaboration
		? await s.store.metadata(s.request.org.id, fileId)
		: initial
	if (!file?.revisionId || file.trashedAt)
		throw new McpCallerError('File not found.')
	if (
		revisionId &&
		!file.revisions.some((revision) => revision.id === revisionId)
	) {
		const revision = await s.store.revision(
			s.request.org.id,
			fileId,
			revisionId,
		)
		if (!revision) throw new McpCallerError('File revision not found.')
		file = { ...file, revisions: [revision, ...file.revisions] }
	}

	return {
		file: { ...file, revisionId: revisionId ?? file.revisionId, content: '' },
		access: s.accessFor(fileId),
	}
}
export async function getFileDescriptor(
	ctx: CapabilityContext,
	fileId: string,
	revisionId?: string,
) {
	return describeFile(await scope(ctx, fileId), fileId, revisionId)
}
export async function getFileAsset(
	ctx: CapabilityContext,
	fileId: string,
	revisionId?: string,
	rangeHeader?: string | null,
	head = false,
) {
	const s = await scope(ctx, fileId),
		descriptor = await describeFile(s, fileId, revisionId)
	const revision = descriptor.file.revisions.find(
		(item) => item.id === descriptor.file.revisionId,
	)
	if (!revision) throw new McpCallerError('File revision not found.')
	const range = parseFileRange(rangeHeader ?? null, revision.bytes)
	const object =
		head || range === false
			? null
			: await fileObjectReader(ctx.env, s.request.org.id).get(
					fileBlobKey(s.request.org.id, fileId, revision.id),
					range ? { range } : undefined,
				)
	if (!head && range !== false && !object)
		throw new McpCallerError('File not found.')
	return { object, range, revision, ...descriptor }
}
export async function getFile(
	ctx: CapabilityContext,
	fileId: string,
	revisionId?: string,
) {
	const s = await scope(ctx, fileId)
	s.require('file:read', fileId)
	return {
		file: await fileOperation(async () => {
			const metadata = s.files.get(fileId)
			if (
				!revisionId &&
				metadata?.encoding !== 'base64' &&
				metadata?.mediaType !== 'application/vnd.kody.directory' &&
				(metadata?.collaboration ||
					(await fileCollaborationEnabled(ctx.env, s.request)))
			)
				return fileRoomRpc(ctx.env, s.request.org.id, fileId).read(
					s.request,
					fileId,
				)
			if (revisionId && metadata?.collaboration)
				await fileRoomRpc(ctx.env, s.request.org.id, fileId).flushForRead(
					s.request,
					fileId,
				)
			const file = await s.store.read(s.request.org.id, fileId, revisionId)
			if (
				!revisionId &&
				s.request.credential.kind !== 'session' &&
				(await fileCollaborationEnabled(ctx.env, s.request))
			)
				await fileRoomRpc(ctx.env, s.request.org.id, fileId).noteActivity(
					s.request,
					fileId,
					'viewed',
				)
			return file
		}),
		access: s.accessFor(fileId),
	}
}
export async function writeFile(
	ctx: CapabilityContext,
	input: z.infer<typeof fileCreateSchema> | z.infer<typeof fileWriteSchema>,
) {
	const s = await scope(ctx, 'name' in input ? input.parent_id : input.file_id)
	const creating = 'name' in input
	s.require(
		creating ? 'file:create' : 'file:write',
		creating ? undefined : input.file_id,
	)
	if (!creating) s.require('file:read', input.file_id)
	if (creating && input.parent_id) {
		s.require('file:read', input.parent_id)
		s.require('file:write', input.parent_id)
	}
	if (!creating) {
		const enabled = await fileCollaborationEnabled(ctx.env, s.request)
		const metadata = await s.store.metadata(s.request.org.id, input.file_id)
		if (metadata?.collaboration && !enabled)
			throw new McpCallerError(
				'Collaboration is temporarily disabled. Your saved file is still available.',
			)
		if (
			metadata?.encoding !== 'base64' &&
			metadata?.mediaType !== 'application/vnd.kody.directory' &&
			(metadata?.collaboration ||
				(await fileCollaborationEnabled(ctx.env, s.request)))
		)
			return withAccountWriteLease({
				db: ctx.env.APP_DB,
				env: ctx.env,
				stableUserId: s.request.org.id,
				holder: 'file-collaboration',
				write: () =>
					fileRoomRpc(ctx.env, s.request.org.id, input.file_id).write(
						s.request,
						input.file_id,
						input.write_id,
						input.base_revision_id,
						input.content,
					),
			})
	}
	return withAccountWriteLease({
		db: ctx.env.APP_DB,
		env: ctx.env,
		stableUserId: s.request.org.id,
		holder: 'files',
		write: async () => {
			const result = await fileOperation(() =>
				s.store.write({
					ownerId: s.request.org.id,
					fileId: input.file_id,
					writeId: input.write_id,
					baseRevisionId: creating ? null : input.base_revision_id,
					content: input.content,
					actorId: s.request.actor!.userId,
					profileId: s.request.credential.profileId ?? null,
					author: s.request.actor!.username ?? 'Member',
					maxBytes: Number(ctx.env.FILES_INCLUDED_BYTES ?? 0),
					...(creating
						? {
								create: {
									name: input.name,
									mediaType: input.media_type,
									encoding: input.encoding,
									parentId: input.parent_id,
								},
							}
						: {}),
				}),
			)
			if (result.ok) {
				if (creating)
					await grantCreatorAccess({
						env: ctx.env,
						orgId: s.request.org.id,
						creatorUserId: s.request.actor!.userId,
						creatorProfileId: s.request.credential.profileId,
						neverRegrant: true,
						resources: [{ resourceType: 'file', resourceId: input.file_id }],
					})
				if (
					result.file.mediaType !== workspaceDirectoryMediaType &&
					(await fileCollaborationEnabled(ctx.env, s.request))
				)
					await fileRoomRpc(
						ctx.env,
						s.request.org.id,
						input.file_id,
					).noteActivity(s.request, input.file_id, 'edited')
				await recordCommittedOrgAuditEvent(
					optionalOrgAuditWriter(ctx.env, s.request),
					{
						orgId: s.request.org.id,
						action: creating ? 'file.create' : 'file.write',
						resourceType: 'file',
						resourceId: input.file_id,
						details: { revisionId: input.write_id },
					},
				)
			}
			return result
		},
	})
}
export async function deleteFile(ctx: CapabilityContext, fileId: string) {
	const s = await scope(ctx, fileId)
	s.require('file:delete', fileId)
	return withAccountWriteLease({
		db: ctx.env.APP_DB,
		env: ctx.env,
		stableUserId: s.request.org.id,
		holder: 'files',
		write: async () => {
			const deleted = await fileOperation(() =>
				s.store.remove(s.request.org.id, fileId),
			)
			if (deleted)
				await recordCommittedOrgAuditEvent(
					optionalOrgAuditWriter(ctx.env, s.request),
					{
						orgId: s.request.org.id,
						action: 'file.delete',
						resourceType: 'file',
						resourceId: fileId,
					},
				)
			return { ok: true as const }
		},
	})
}

export async function previewFileMove(
	ctx: CapabilityContext,
	fileId: string,
	parentId: string | null,
) {
	const s = await scope(ctx)
	s.require('file:read', fileId)
	s.require('file:write', fileId)
	if (parentId) {
		s.require('file:read', parentId)
		s.require('file:write', parentId)
	} else s.require('file:create')
	const file = s.files.get(fileId)
	if (!file) throw new McpCallerError('File not found.')
	const chain = (id?: string | null) => {
		const values: Array<{ id: string; version: number; mode: string }> = []
		const seen = new Set<string>()
		while (id && !seen.has(id)) {
			seen.add(id)
			const item = s.files.get(id)
			if (!item) throw new McpCallerError('Parent page or directory not found.')
			values.push({
				id,
				version: item.metadataVersion ?? 0,
				mode: item.accessMode ?? 'inherit',
			})
			id = item.parentId
		}
		return values
	}
	const before = chain(file.parentId),
		after = chain(parentId)
	const differing = [
		...before.filter((item) => !after.some((next) => next.id === item.id)),
		...after.filter(
			(item) => !before.some((previous) => previous.id === item.id),
		),
	]
	const grants = differing.length
		? await ctx.env.APP_DB.prepare(
				`SELECT id,resource_id FROM grants WHERE org_id = ? AND resource_type = 'file' AND deleted_at IS NULL AND (expires_at IS NULL OR expires_at > ?) AND resource_id IN (${differing.map(() => '?').join(',')})`,
			)
				.bind(
					s.request.org.id,
					new Date().toISOString(),
					...differing.map((item) => item.id),
				)
				.all<{ id: string; resource_id: string }>()
		: { results: [] }
	const epoch = await ctx.env.APP_DB.prepare(
		'SELECT access_epoch FROM orgs WHERE id = ? AND deleted_at IS NULL',
	)
		.bind(s.request.org.id)
		.first<{ access_epoch: number }>()
	const { sha256Hex } = await import('@kody-internal/shared/sha256.ts')
	return {
		changed:
			differing.some((item) => item.mode === 'restricted') ||
			grants.results.length > 0,
		token: await sha256Hex(
			new TextEncoder().encode(
				JSON.stringify({
					fileId,
					version: file.metadataVersion ?? 0,
					parentId,
					before,
					after,
					epoch: epoch?.access_epoch,
				}),
			),
		),
	}
}

export async function manageFile(
	ctx: CapabilityContext,
	input: z.infer<typeof fileManageSchema>,
) {
	const s = await scope(ctx)
	if (
		input.action === 'access' &&
		!(await fileCollaborationEnabled(ctx.env, s.request))
	)
		throw new McpCallerError('File collaboration is not enabled.')
	const permission =
		input.action === 'access'
			? 'file:manage_access'
			: input.action === 'trash' || input.action === 'restore'
				? 'file:delete'
				: 'file:write'
	s.require('file:read', input.file_id)
	s.require(permission, input.file_id)
	return withAccountWriteLease({
		db: ctx.env.APP_DB,
		env: ctx.env,
		stableUserId: s.request.org.id,
		holder: 'files',
		write: async () => {
			const files = await s.store.list(s.request.org.id, true)
			const file = await fileOperation(() =>
				s.store.manage({
					ownerId: s.request.org.id,
					fileId: input.file_id,
					operationId: input.operation_id,
					expectedVersion: input.expected_version,
					action: input.action,
					name: input.name,
					parentId: input.parent_id,
					accessMode: input.access_mode,
					allowedIds: files
						.filter(
							(file) =>
								s.holds('file:read', file.id) && s.holds(permission, file.id),
						)
						.map((file) => file.id),
					writableParents: files
						.filter(
							(file) =>
								s.holds('file:read', file.id) && s.holds('file:write', file.id),
						)
						.map((file) => file.id),
					canCreate: s.holds('file:create'),
				}),
			)
			await recordCommittedOrgAuditEvent(
				optionalOrgAuditWriter(ctx.env, s.request),
				{
					orgId: s.request.org.id,
					action: 'file.' + input.action,
					resourceType: 'file',
					resourceId: input.file_id,
					details: { operationId: input.operation_id },
				},
			)
			return { file }
		},
	})
}

export async function patchPage(
	ctx: CapabilityContext,
	input: z.infer<typeof pagePatchSchema>,
) {
	const s = await scope(ctx, input.file_id)
	s.require('file:read', input.file_id)
	s.require('file:write', input.file_id)
	// Read the declared base so retries produce the same payload, even after the write committed.
	const { file } = await getFile(ctx, input.file_id, input.base_revision_id)
	if (file.mediaType !== workspacePageMediaType)
		throw new McpCallerError('This item is not a workspace page.')
	let content: string
	try {
		content = patchWorkspacePage(file.content, input.operations)
	} catch (error) {
		throw new McpCallerError(
			error instanceof Error ? error.message : 'Invalid page edits.',
		)
	}
	return writeFile(ctx, {
		file_id: input.file_id,
		write_id: input.write_id,
		base_revision_id: input.base_revision_id,
		content,
	})
}

export async function getFileCollaboration(
	ctx: CapabilityContext,
	fileId: string,
	cursor?: string,
) {
	const s = await scope(ctx, fileId)
	s.require('file:read', fileId)
	if (!(await fileCollaborationEnabled(ctx.env, s.request)))
		throw new McpCallerError('File collaboration is not enabled.')
	return fileRoomRpc(ctx.env, s.request.org.id, fileId).snapshot(
		s.request,
		fileId,
		cursor,
	)
}
export async function getFileThreadComments(
	ctx: CapabilityContext,
	fileId: string,
	threadId: string,
	cursor?: string,
) {
	const s = await scope(ctx, fileId)
	s.require('file:read', fileId)
	if (!(await fileCollaborationEnabled(ctx.env, s.request)))
		throw new McpCallerError('File collaboration is not enabled.')
	return fileRoomRpc(ctx.env, s.request.org.id, fileId).threadComments(
		s.request,
		fileId,
		threadId,
		cursor,
	)
}

export async function commentOnFile(
	ctx: CapabilityContext,
	fileId: string,
	command: CommentCommand,
) {
	const s = await scope(ctx, fileId)
	s.require('file:read', fileId)
	if (!(await fileCollaborationEnabled(ctx.env, s.request)))
		throw new McpCallerError('File collaboration is not enabled.')
	return withAccountWriteLease({
		db: ctx.env.APP_DB,
		env: ctx.env,
		stableUserId: s.request.org.id,
		holder: 'file-comments',
		write: () =>
			fileRoomRpc(ctx.env, s.request.org.id, fileId).comment(
				s.request,
				fileId,
				command,
			),
	})
}
export async function connectFileCollaboration(
	ctx: CapabilityContext,
	fileId: string,
	sessionId: string,
	session: FileSessionProof,
) {
	const s = await scope(ctx, fileId)
	s.require('file:read', fileId)
	if (!(await fileCollaborationEnabled(ctx.env, s.request)))
		throw new McpCallerError('File collaboration is not enabled.')
	return fileRoomRpc(ctx.env, s.request.org.id, fileId).openSession(
		s.request,
		fileId,
		sessionId,
		session,
	)
}

export async function getFileHistory(
	ctx: CapabilityContext,
	fileId: string,
	cursor?: string,
) {
	const s = await scope(ctx, fileId)
	s.require('file:read', fileId)
	return s.store.history(s.request.org.id, fileId, cursor)
}
export async function listFileDirectory(
	ctx: CapabilityContext,
	parentId: string | null,
	cursor?: string,
) {
	const request = requireMcpRequest(ctx.callerContext)
	requireMcpUser(ctx.callerContext)
	const effective = await fileEffectivePermissions(ctx.env, request)
	const store = fileStoreRpc(ctx.env, request.org.id)
	const files = parentId
		? await loadFileAncestors(
				(id) => store.metadata(request.org.id, id),
				parentId,
			)
		: new Map<string, FileMetadata>()
	if (parentId && !fileTreePermission(effective, files, 'file:read', parentId))
		throw new McpCallerError('You do not have access to this directory.')
	const page = await store.directoryPage(request.org.id, parentId, cursor)
	for (const file of page.files) files.set(file.id, file)
	return {
		...page,
		files: page.files.filter((file) =>
			fileTreePermission(effective, files, 'file:read', file.id),
		),
	}
}

export async function applyFileLiveUpdate(
	ctx: CapabilityContext,
	fileId: string,
	operationId: string,
	update: string,
) {
	const s = await scope(ctx, fileId)
	s.require('file:write', fileId)
	if (!(await fileCollaborationEnabled(ctx.env, s.request)))
		throw new McpCallerError('File collaboration is not enabled.')
	return fileRoomRpc(ctx.env, s.request.org.id, fileId).update(
		s.request,
		fileId,
		operationId,
		update,
	)
}

export async function setFileAgentPresence(
	ctx: CapabilityContext,
	fileId: string,
	presence: Parameters<ReturnType<typeof fileRoomRpc>['setAgentPresence']>[2],
) {
	const s = await scope(ctx, fileId)
	s.require('file:read', fileId)
	if (!(await fileCollaborationEnabled(ctx.env, s.request)))
		throw new McpCallerError('File collaboration is not enabled.')
	return fileRoomRpc(ctx.env, s.request.org.id, fileId).setAgentPresence(
		s.request,
		fileId,
		presence,
	)
}
