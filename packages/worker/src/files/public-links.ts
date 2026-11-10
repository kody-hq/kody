import {
	defaultFileAssetSettings,
	signedAssetRouteToken,
	type FileAssetSettings,
} from '#universal/file-assets.ts'
import { isWorkspaceContainer } from '#universal/workspace-page.ts'
import type { FileMetadata } from '#universal/files.ts'
import { sealFileShareValue, openFileShareValue } from '#mcp/secrets/crypto.ts'
import type { CapabilityContext } from '#mcp/capabilities/types.ts'
import { requireMcpRequest } from '#mcp/capabilities/meta/require-user.ts'
import { fileCollaborationAccess } from './collaboration-access.ts'
import { fileCollaborationEnabled, fileLinkEnabled } from './feature.ts'
import { fileStoreRpc } from './client.ts'
import { fileRoomRpc } from './room.ts'
import { sha256Hex } from '@kody-internal/shared/sha256.ts'
import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { withAccountWriteLease } from '#worker/account/deletion-state.ts'
import { getOrgBySlug, isOrgActive } from '#worker/orgs/repo.ts'
import {
	optionalOrgAuditWriter,
	recordCommittedOrgAuditEvent,
} from '#worker/orgs/org-audit.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import { filePublicParentAllows, loadFileAncestors } from './tree-access.ts'

export async function changeFilePublicLink(
	ctx: CapabilityContext,
	fileId: string,
	enabled: boolean,
) {
	const request = requireMcpRequest(ctx.callerContext)
	const { access } = await fileCollaborationAccess(ctx.env, request, fileId)
	if (!access.manage || !(await fileCollaborationEnabled(ctx.env, request)))
		throw new McpCallerError('File access management is required.')
	if (enabled && !(await fileLinkEnabled(ctx.env, request.org.id)))
		throw new McpCallerError(
			'Sharing links requires Files to be enabled for the organization.',
		)
	if (
		enabled &&
		!filePublicParentAllows(
			await loadFileAncestors(
				(id) =>
					fileStoreRpc(ctx.env, request.org.id).metadata(request.org.id, id),
				fileId,
			),
			fileId,
		)
	)
		throw new McpCallerError(
			'A restricted parent blocks public links on this item.',
		)
	const token = enabled
		? crypto.randomUUID().replaceAll('-', '') +
			crypto.randomUUID().replaceAll('-', '')
		: null
	const tokenHash = token ? await sha256(token) : null
	const sealed = token
		? await sealFileShareValue(
				ctx.env,
				'public-link',
				`${request.org.id}:${fileId}`,
				token,
			)
		: undefined
	await withAccountWriteLease({
		db: ctx.env.APP_DB,
		env: ctx.env,
		stableUserId: request.org.id,
		holder: 'file-public-link',
		write: async () => {
			await fileStoreRpc(ctx.env, request.org.id).setPublicLink(
				request.org.id,
				fileId,
				tokenHash,
				sealed,
			)
			await recordCommittedOrgAuditEvent(
				optionalOrgAuditWriter(ctx.env, request),
				{
					orgId: request.org.id,
					action: enabled
						? 'file.public-link.enable'
						: 'file.public-link.disable',
					resourceType: 'file',
					resourceId: fileId,
				},
			)
		},
	})
	return {
		href: token
			? `/shared-files/${encodeURIComponent(request.org.slug!)}/${fileId}/${token}`
			: null,
	}
}
/** Only the access-management boundary may recover a link for copying. */
export async function readManagedPublicLink(
	env: Env,
	ownerId: Parameters<typeof fileStoreRpc>[1],
	orgSlug: string,
	fileId: string,
) {
	const store = fileStoreRpc(env, ownerId)
	const sealed = await store.publicLinkSecret(ownerId, fileId)
	if (!sealed) return null
	const token = await openFileShareValue(
		env,
		'public-link',
		`${ownerId}:${fileId}`,
		sealed,
	).catch(() => null)
	if (!token) return null
	if (!(await store.publicLinkMatches(ownerId, fileId, await sha256(token))))
		return null
	return `/shared-files/${encodeURIComponent(orgSlug)}/${fileId}/${token}`
}

async function sha256(value: string) {
	return sha256Hex(new TextEncoder().encode(value))
}

/** Token scope is intersected with the live hierarchy. Restricted descendants are never published implicitly. */
export async function resolvePublicFileScope(
	env: Env,
	orgSlug: string,
	rootId: string,
	token: string,
	itemId = rootId,
) {
	if (
		!/^[a-zA-Z0-9_-]+$/.test(orgSlug) ||
		!/^[a-f0-9]{64}$/.test(token) ||
		env.FILES_COLLABORATION_ENABLED === 'false'
	)
		throw new Error('Shared file unavailable.')
	const org = await getOrgBySlug(env.APP_DB, orgSlug)
	if (!org || !(await isOrgActive(env.APP_DB, org.id)))
		throw new Error('Shared file unavailable.')
	if (!(await fileLinkEnabled(env, org.id)))
		throw new Error('Shared file unavailable.')
	const ownerId = ownerIdFromStored(org.id),
		store = fileStoreRpc(env, ownerId)
	if (!(await store.publicLinkMatches(ownerId, rootId, await sha256(token))))
		throw new Error('Shared file unavailable.')
	const files = await store.list(ownerId, false)
	const byId = new Map(files.map((file) => [file.id, file]))
	if (!filePublicParentAllows(byId, rootId))
		throw new Error('Shared file unavailable.')
	const visible = files.filter((file) => {
		const seen = new Set<string>()
		let current: typeof file | undefined = file
		while (current && !seen.has(current.id)) {
			seen.add(current.id)
			if (current.id === rootId) return true
			if (current.accessMode === 'restricted') return false
			current = current.parentId ? byId.get(current.parentId) : undefined
		}
		return false
	})
	const file = visible.find((file) => file.id === itemId)
	if (!file) throw new Error('Shared file unavailable.')
	return { ownerId, file, files: visible }
}

/** This helper reads only a file already checked against a public scope. */
export async function readScopedPublishedFile(
	env: Env,
	ownerId: Parameters<typeof fileStoreRpc>[1],
	file: FileMetadata,
) {
	return file.collaboration
		? await fileRoomRpc(env, ownerId, file.id).readPublished(ownerId, file.id)
		: file.encoding === 'base64'
			? { ...file, content: '' }
			: await fileStoreRpc(env, ownerId).read(ownerId, file.id)
}

export async function publicFileScope(
	env: Env,
	orgSlug: string,
	rootId: string,
	token: string,
	itemId = rootId,
) {
	const scope = await resolvePublicFileScope(
		env,
		orgSlug,
		rootId,
		token,
		itemId,
	)
	return {
		ownerId: scope.ownerId,
		file: await readScopedPublishedFile(env, scope.ownerId, scope.file),
		files: scope.files.map(({ id, name, mediaType, parentId, encoding }) => ({
			id,
			name,
			mediaType,
			parentId: id === rootId ? undefined : parentId,
			encoding,
		})),
	}
}

export function sealSignedAsset(
	env: Env,
	ownerId: Parameters<typeof fileStoreRpc>[1],
	fileId: string,
	revisionId: string,
	expiresAt: number,
) {
	return sealFileShareValue(
		env,
		'asset-url',
		`${ownerId}:${fileId}`,
		JSON.stringify({ expiresAt, revisionId }),
	)
}

export function openSignedAsset(
	env: Env,
	ownerId: Parameters<typeof fileStoreRpc>[1],
	fileId: string,
	signature: string,
) {
	return openFileShareValue(env, 'asset-url', `${ownerId}:${fileId}`, signature)
}

async function managedAsset(ctx: CapabilityContext, fileId: string) {
	const { request, access } = await fileCollaborationAccess(
		ctx.env,
		requireMcpRequest(ctx.callerContext),
		fileId,
	)
	if (!access.manage || !(await fileCollaborationEnabled(ctx.env, request)))
		throw new McpCallerError('File access management is required.')
	const store = fileStoreRpc(ctx.env, request.org.id)
	const file = await store.metadata(request.org.id, fileId)
	if (
		!file?.revisionId ||
		file.trashedAt ||
		isWorkspaceContainer(file.mediaType)
	)
		throw new McpCallerError('File not found.')
	return {
		store,
		ownerId: request.org.id,
		slug: request.org.slug!,
		revisionId: file.revisionId,
	}
}

export async function getFileAssetSettings(
	ctx: CapabilityContext,
	fileId: string,
) {
	const { store, ownerId, slug } = await managedAsset(ctx, fileId)
	const chain = await loadFileAncestors(
		(id) => store.metadata(ownerId, id),
		fileId,
	)
	const link = filePublicParentAllows(chain, fileId)
		? await readManagedPublicLink(ctx.env, ownerId, slug, fileId)
		: null
	return {
		...((await store.assetSettings(ownerId, fileId)) ??
			defaultFileAssetSettings),
		publicAssetHref: link
			? `${link.replace('/shared-files/', '/shared-file-assets/')}/${fileId}?asset=1`
			: null,
	}
}

export async function setFileAssetSettings(
	ctx: CapabilityContext,
	fileId: string,
	settings: FileAssetSettings,
) {
	const { store, ownerId } = await managedAsset(ctx, fileId)
	await store.setAssetSettings(ownerId, fileId, settings)
	return { ok: true as const }
}

export async function mintFileAssetUrl(
	ctx: CapabilityContext,
	fileId: string,
	minutes: number,
) {
	const { ownerId, slug, revisionId } = await managedAsset(ctx, fileId)
	if (!(await fileLinkEnabled(ctx.env, ownerId)))
		throw new McpCallerError(
			'Sharing links requires Files to be enabled for the organization.',
		)
	const expiresAt = Date.now() + minutes * 60_000
	const signature = await sealSignedAsset(
		ctx.env,
		ownerId,
		fileId,
		revisionId,
		expiresAt,
	)
	return {
		href: `/shared-file-assets/${encodeURIComponent(slug)}/${fileId}/${signedAssetRouteToken}/${fileId}?${new URLSearchParams({ signature })}`,
		expiresAt: new Date(expiresAt).toISOString(),
		revisionId,
	}
}
