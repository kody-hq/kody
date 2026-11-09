import {
	prepareSharedCopy,
	copySharedItem,
	publicCopySourceSchema,
	publicCopyStepSchema,
} from '#worker/files/shared-copy-service.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import { getAppBaseUrl } from '#worker/app-base-url.ts'
import {
	getFileStorage,
	configureFileStorage,
} from '#worker/files/storage-settings.ts'
import {
	fileStorageConfigSchema,
	fileStorageStatusSchema,
} from '#universal/file-storage.ts'
import {
	commentCommandSchema,
	fileLiveUpdateSchema,
	fileAgentPresenceSchema,
	encodeCollaborationBytes,
	roomSnapshotSchema,
	threadSchema,
	commentSchema,
	threadCommentPageSchema,
} from '#universal/file-collaboration.ts'
import { pagePatchSchema } from '#universal/workspace-page.ts'
import { z } from 'zod'
import { defineDomain } from '#mcp/capabilities/define-domain.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '../domain-metadata.ts'
import {
	fileAccessSchema,
	fileManageSchema,
	fileCreateSchema,
	fileDocumentSchema,
	fileIdSchema,
	fileMetadataSchema,
	fileWriteOutputSchema,
	fileWriteSchema,
} from '#universal/files.ts'
import {
	getFileThreadComments,
	getFileAsset,
	applyFileLiveUpdate,
	setFileAgentPresence,
	getFileHistory,
	listFileDirectory,
	previewFileMove,
	getFileCollaboration,
	commentOnFile,
	deleteFile,
	manageFile,
	patchPage,
	getFile,
	listFiles,
	writeFile,
} from '#worker/files/service.ts'

import { assetCacheControls } from '#universal/file-assets.ts'
import {
	changeFilePublicLink,
	getFileAssetSettings,
	setFileAssetSettings,
	mintFileAssetUrl,
} from '#worker/files/public-links.ts'

const assetSettingsSchema = z.object({
	cacheControl: z.enum(assetCacheControls),
	disposition: z.enum(['inline', 'attachment']),
})

const batchWriteSchema = z
	.array(z.union([fileWriteSchema, fileCreateSchema]))
	.min(1)
	.max(32)
	.refine(
		(items) =>
			items.reduce(
				(size, item) => size + new TextEncoder().encode(item.content).length,
				0,
			) <=
			24 * 1024 * 1024,
		'The batch payload exceeds 24 MiB.',
	)
const downloadChunkSchema = z.object({
	file_id: fileIdSchema,
	revision_id: fileIdSchema.optional(),
	offset: z
		.number()
		.int()
		.min(0)
		.max(Number.MAX_SAFE_INTEGER - 262144)
		.default(0),
	length: z.number().int().min(1).max(262144).default(262144),
})

const domain = capabilityDomainNames.files
const common = {
	featureFlag: 'files-workspace' as const,
	contextRuns: 'allow' as const,
	idempotent: true,
	keywords: ['files', 'documents', 'markdown', 'csv', 'html', 'assets'],
}
export const filesDomain = defineDomain({
	name: domain,
	description:
		'Create, read, edit and version private workspace files. Sharing uses the existing file resource grants and invites.',
	keywords: common.keywords,
	capabilities: [
		defineDomainCapability(domain, {
			...common,
			name: 'fileBatchWrite',
			orgPermission: 'file:read',
			readOnly: false,
			destructive: false,
			description:
				'Create or replace up to 32 files in order, using the same permissions and size limits as fileCreate and fileWrite. A failure stops the batch after any earlier commits. Retry with the same file and write IDs.',
			inputSchema: z.object({ items: batchWriteSchema }),
			outputSchema: z.object({ files: z.array(fileMetadataSchema) }),
			handler: async ({ items }, ctx) => {
				const files = []
				for (const item of items) {
					const result = await writeFile(ctx, item)
					if (!result.ok)
						throw new McpCallerError(
							`Revision conflict on file ${item.file_id}.`,
						)
					files.push(result.file)
				}
				return { files }
			},
		}),
		defineDomainCapability(domain, {
			...common,
			name: 'fileBatchDownload',
			orgPermission: 'file:read',
			readOnly: true,
			destructive: false,
			description:
				'Read up to eight byte ranges as base64. Pin the returned revision_id and pass next_offset to continue a download. List a directory first to download its files.',
			inputSchema: z.object({
				items: z.array(downloadChunkSchema).min(1).max(8),
			}),
			outputSchema: z.object({
				items: z.array(
					z.object({
						file_id: fileIdSchema,
						revision_id: fileIdSchema,
						bytes: z.number(),
						content: z.string(),
						next_offset: z.number().nullable(),
					}),
				),
			}),
			handler: async ({ items }, ctx) => {
				const chunks = []
				for (const item of items) {
					const result = await getFileAsset(
						ctx,
						item.file_id,
						item.revision_id,
						`bytes=${item.offset}-${item.offset + item.length - 1}`,
					)
					if (result.range === false && item.offset !== result.revision.bytes)
						throw new McpCallerError(`Offset is outside file ${item.file_id}.`)
					const bytes = result.object
						? new Uint8Array(await result.object.arrayBuffer())
						: new Uint8Array()
					const next = item.offset + bytes.length
					chunks.push({
						file_id: item.file_id,
						revision_id: result.revision.id,
						bytes: result.revision.bytes,
						content: encodeCollaborationBytes(bytes),
						next_offset: next < result.revision.bytes ? next : null,
					})
				}
				return { items: chunks }
			},
		}),
		defineDomainCapability(domain, {
			...common,
			idempotent: false,
			name: 'fileSharedCopyPrepare',
			orgPermission: 'file:create',
			readOnly: false,
			destructive: false,
			description:
				'Plan a copy of a publicly shared file or folder into the current workspace. Pass the share scope and token, then call fileSharedCopyStep in index order.',
			inputSchema: publicCopySourceSchema,
			outputSchema: z.object({
				ticket: z.string(),
				count: z.number(),
				name: z.string(),
				destination: z.string(),
				fileId: fileIdSchema,
			}),
			handler: (args, ctx) => prepareSharedCopy(ctx, args),
		}),
		defineDomainCapability(domain, {
			...common,
			name: 'fileSharedCopyStep',
			orgPermission: 'file:create',
			readOnly: false,
			destructive: false,
			description:
				'Copy one item from a prepared shared-folder copy. Start at index zero, use the same ticket and index to retry, and continue through count minus one.',
			inputSchema: publicCopyStepSchema,
			outputSchema: z.object({ ok: z.literal(true) }),
			handler: (args, ctx) => copySharedItem(ctx, args),
		}),
		defineDomainCapability(domain, {
			...common,
			name: 'fileLiveUpdate',
			orgPermission: 'file:write',
			readOnly: false,
			destructive: false,
			description:
				'Apply a base64 Yjs update to the live file room. Read state with fileCollaborationGet. Reuse the operation ID when retrying the same update. Browser collaborators receive the update.',
			inputSchema: fileLiveUpdateSchema.extend({ file_id: fileIdSchema }),
			outputSchema: z.object({
				sequence: z.number(),
				revisionId: fileIdSchema,
			}),
			handler: (args, ctx) =>
				applyFileLiveUpdate(ctx, args.file_id, args.operationId, args.update),
		}),
		defineDomainCapability(domain, {
			...common,
			idempotent: false,
			name: 'filePresenceSet',
			orgPermission: 'file:read',
			readOnly: false,
			destructive: false,
			description:
				'Publish your agent presence and optional Yjs selection to live collaborators. Refresh while active. Pass null to clear presence.',
			inputSchema: z.object({
				file_id: fileIdSchema,
				presence: fileAgentPresenceSchema.nullable(),
			}),
			outputSchema: z.object({ ok: z.literal(true) }),
			handler: (args, ctx) =>
				setFileAgentPresence(ctx, args.file_id, args.presence),
		}),

		defineDomainCapability(domain, {
			...common,
			name: 'fileStorageGet',
			orgPermission: 'file:manage_access',
			readOnly: true,
			destructive: false,
			description:
				'Read file storage connections. Workspace owners only. Storage is hidden from the ordinary file browsing experience.',
			inputSchema: z.object({}),
			outputSchema: fileStorageStatusSchema,
			handler: (_args, ctx) => getFileStorage(ctx),
		}),
		defineDomainCapability(domain, {
			...common,
			name: 'fileStorageSet',
			orgPermission: 'file:manage_access',
			readOnly: false,
			destructive: false,
			description:
				'Connect R2 or Amazon S3 for future revisions, or pass null to use included storage. Requires a dedicated workspace credential containing JSON accessKeyId and secretAccessKey, approved for the endpoint host. Old revisions keep their storage connection. Existing bytes are never silently migrated. Workspace owners only.',
			inputSchema: z.object({
				configuration: fileStorageConfigSchema.nullable(),
			}),
			outputSchema: fileStorageStatusSchema,
			handler: (args, ctx) => configureFileStorage(ctx, args.configuration),
		}),
		defineDomainCapability(domain, {
			...common,
			name: 'fileHistoryGet',
			orgPermission: 'file:read',
			readOnly: true,
			destructive: false,
			description:
				'Read immutable file history in pages, newest first. Pass nextCursor to continue. All retained revisions stay readable by ID.',
			inputSchema: z.object({
				file_id: fileIdSchema,
				cursor: fileIdSchema.optional(),
			}),
			outputSchema: z.object({
				revisions: fileMetadataSchema.shape.revisions,
				nextCursor: fileIdSchema.nullable(),
			}),
			handler: (args, ctx) => getFileHistory(ctx, args.file_id, args.cursor),
		}),
		defineDomainCapability(domain, {
			...common,
			name: 'fileDirectoryList',
			orgPermission: 'file:read',
			readOnly: true,
			destructive: false,
			description:
				'Read one directory in alphabetical pages of at most 100 authorized items. Omit parent_id for the workspace root. Pass nextCursor to continue, including when a page has no visible items.',
			inputSchema: z.object({
				parent_id: fileIdSchema.nullable().optional(),
				cursor: fileIdSchema.optional(),
			}),
			outputSchema: z.object({
				files: z.array(fileMetadataSchema),
				nextCursor: fileIdSchema.nullable(),
			}),
			handler: (args, ctx) =>
				listFileDirectory(ctx, args.parent_id ?? null, args.cursor),
		}),
		defineDomainCapability(domain, {
			...common,
			name: 'fileThreadCommentsGet',
			orgPermission: 'file:read',
			readOnly: true,
			destructive: false,
			description:
				'Read a discussion’s comments in chronological pages. Pass nextCursor for the next page.',
			inputSchema: z.object({
				file_id: fileIdSchema,
				thread_id: fileIdSchema,
				cursor: z.string().max(300).optional(),
			}),
			outputSchema: threadCommentPageSchema,
			handler: (args, ctx) =>
				getFileThreadComments(ctx, args.file_id, args.thread_id, args.cursor),
		}),
		defineDomainCapability(domain, {
			...common,
			idempotent: false,
			name: 'filePublicLinkSet',
			orgPermission: 'file:manage_access',
			readOnly: false,
			destructive: false,
			description:
				'Explicitly create or revoke an anonymous read link for a file or directory. Creating replaces any previous public link. Directory links include inherited descendants but exclude restricted subtrees. Ordinary file links do not grant access. Comments, people, and history stay private.',
			inputSchema: z.object({ file_id: fileIdSchema, enabled: z.boolean() }),
			outputSchema: z.object({ href: z.string().nullable() }),
			handler: (args, ctx) =>
				changeFilePublicLink(ctx, args.file_id, args.enabled),
		}),
		defineDomainCapability(domain, {
			...common,
			name: 'fileAssetGet',
			orgPermission: 'file:manage_access',
			readOnly: true,
			destructive: false,
			description:
				'Read asset delivery settings and the public asset path, if the file has its own public link. Use filePublicLinkSet to enable or revoke it.',
			inputSchema: z.object({ file_id: fileIdSchema }),
			outputSchema: assetSettingsSchema.extend({
				publicAssetHref: z.string().nullable(),
				publicAssetUrl: z.string().nullable(),
			}),
			handler: async (args, ctx) => {
				const settings = await getFileAssetSettings(ctx, args.file_id)
				return {
					...settings,
					publicAssetUrl: settings.publicAssetHref
						? new URL(settings.publicAssetHref, getAppBaseUrl(ctx)).href
						: null,
				}
			},
		}),
		defineDomainCapability(domain, {
			...common,
			name: 'fileAssetSet',
			orgPermission: 'file:manage_access',
			readOnly: false,
			destructive: false,
			description:
				'Set public asset cache control and inline or attachment disposition. Signed downloads always bypass caching.',
			inputSchema: assetSettingsSchema.extend({ file_id: fileIdSchema }),
			outputSchema: z.object({ ok: z.literal(true) }),
			handler: ({ file_id, ...settings }, ctx) =>
				setFileAssetSettings(ctx, file_id, settings),
		}),
		defineDomainCapability(domain, {
			...common,
			idempotent: false,
			name: 'fileAssetSign',
			orgPermission: 'file:manage_access',
			readOnly: false,
			destructive: false,
			description:
				'Create a temporary bearer URL for the current saved revision. Returns the URL and an expiration timestamp. Anyone with the URL can fetch the revision until expiry.',
			inputSchema: z.object({
				file_id: fileIdSchema,
				minutes: z.number().int().min(1).max(1440),
			}),
			outputSchema: z.object({
				href: z.string(),
				url: z.string(),
				expiresAt: z.string(),
				revisionId: fileIdSchema,
			}),
			handler: async (args, ctx) => {
				const signed = await mintFileAssetUrl(ctx, args.file_id, args.minutes)
				return {
					...signed,
					url: new URL(signed.href, getAppBaseUrl(ctx)).href,
				}
			},
		}),
		defineDomainCapability(domain, {
			...common,
			name: 'fileMovePreview',
			orgPermission: 'file:read',
			readOnly: true,
			destructive: false,
			description:
				'Check whether a move changes inherited access. Pass the returned token as access_preview_token when moving. Direct shares remain attached to stable file IDs.',
			inputSchema: z.object({
				file_id: fileIdSchema,
				parent_id: fileIdSchema.nullable(),
			}),
			outputSchema: z.object({ changed: z.boolean(), token: z.string() }),
			handler: (args, ctx) =>
				previewFileMove(ctx, args.file_id, args.parent_id),
		}),
		defineDomainCapability(domain, {
			...common,
			name: 'fileCollaborationGet',
			orgPermission: 'file:read',
			readOnly: true,
			destructive: false,
			description:
				'Read the current shared document, file discussions, and authorized recent participants. Supports paged discussions. Collaboration must be enabled.',
			inputSchema: z.object({
				file_id: fileIdSchema,
				cursor: z.string().optional(),
			}),
			outputSchema: roomSnapshotSchema,
			handler: (args, ctx) =>
				getFileCollaboration(ctx, args.file_id, args.cursor),
		}),
		defineDomainCapability(domain, {
			...common,
			name: 'fileComment',
			orgPermission: 'file:read',
			readOnly: false,
			destructive: false,
			description:
				'Create or reply to a file discussion, edit your own comment, resolve/reopen a thread, remove a comment under moderation policy, or mark a discussion read. Use unique operation IDs for safe retries and expectedVersion for changes. Video and audio anchors use timeMs from the start of playback. Audio, image, JSON and CSV anchors require the current revisionId from fileCollaborationGet. Image x and y are fractions from the top-left of the image. JSON pointer is a JSON Pointer (empty string for the root). CSV row and column are zero-based and row 0 is the header. Text anchors use encoded Yjs relative positions. Author identity comes from authentication. Mentions do not start agents.',
			inputSchema: z.object({
				file_id: fileIdSchema,
				command: commentCommandSchema,
			}),
			outputSchema: z.object({
				sequence: z.number(),
				replayed: z.boolean(),
				threads: z.array(threadSchema),
				comments: z.array(commentSchema),
				nextCursor: z.string().nullable(),
				commentCursors: z.record(z.string(), z.string().nullable()),
			}),
			handler: (args, ctx) => commentOnFile(ctx, args.file_id, args.command),
		}),

		defineDomainCapability(domain, {
			...common,
			name: 'fileList',
			orgPermission: 'file:read',
			readOnly: true,
			destructive: false,
			description: 'List files you can read in this workspace.',
			inputSchema: z.object({ include_trash: z.boolean().optional() }),
			outputSchema: z.object({
				files: z.array(fileMetadataSchema.extend({ access: fileAccessSchema })),
				can_create: z.boolean(),
				writes_enabled: z.boolean(),
			}),
			handler: (args, ctx) => listFiles(ctx, args.include_trash),
		}),
		defineDomainCapability(domain, {
			...common,
			name: 'fileGet',
			orgPermission: 'file:read',
			readOnly: true,
			destructive: false,
			description:
				'Read a file or an immutable revision. Use headVersion, when present, or revisionId as base_revision_id for fileWrite. revisionId and the revisions list identify immutable saved checkpoints, while headVersion identifies the current live content.',
			inputSchema: z.object({
				file_id: fileIdSchema,
				revision_id: fileIdSchema.optional(),
			}),
			outputSchema: z.object({
				file: fileDocumentSchema,
				access: fileAccessSchema,
			}),
			handler: (args, ctx) => getFile(ctx, args.file_id, args.revision_id),
		}),
		defineDomainCapability(domain, {
			...common,
			name: 'fileCreate',
			orgPermission: 'file:create',
			readOnly: false,
			destructive: false,
			description:
				'Create a private file, up to 64 KiB for text or 16 MiB for binary. Set encoding to base64 for raw bytes. For a directory, use media_type application/vnd.kody.directory and empty content. Set parent_id to nest inside a directory or page. Supply unique file_id and write_id UUIDs. Reuse both for a retry of the same creation.',
			inputSchema: fileCreateSchema,
			outputSchema: fileWriteOutputSchema,
			handler: (args, ctx) => writeFile(ctx, args),
		}),
		defineDomainCapability(domain, {
			...common,
			name: 'fileWrite',
			orgPermission: 'file:write',
			readOnly: false,
			destructive: false,
			description:
				'Save a new immutable revision, up to 64 KiB for text or 16 MiB for binary. Supply the current base_revision_id and a unique write_id. Match the encoding returned by fileGet. Conflicts return current and proposed contents without overwriting either.',
			inputSchema: fileWriteSchema,
			outputSchema: fileWriteOutputSchema,
			handler: (args, ctx) => writeFile(ctx, args),
		}),
		defineDomainCapability(domain, {
			...common,
			name: 'pagePatch',
			orgPermission: 'file:write',
			readOnly: false,
			destructive: false,
			description:
				'Edit workspace page blocks by stable ID with an atomic batch of insert, replace, remove, and move operations. Read fileGet first, supply its headVersion (or revisionId when absent) as base_revision_id and a unique write_id. A null after_id inserts or moves to the beginning. Replacement retains the supplied block ID. Stale bases return a revision conflict without overwriting newer work. Reuse the same write_id and operations when retrying.',
			inputSchema: pagePatchSchema,
			outputSchema: fileWriteOutputSchema,
			handler: (args, ctx) => patchPage(ctx, args),
		}),
		defineDomainCapability(domain, {
			...common,
			name: 'fileManage',
			orgPermission: 'file:read',
			readOnly: false,
			destructive: false,
			description:
				'Rename, move, trash, restore, or set an item’s inherited/restricted access policy. Access policy changes require manage_access. Use fileMovePreview before moving and include its token when inherited access changes. Use metadataVersion (or zero) as expected_version and a unique operation_id for safe retries. Folder trash and restore include descendants. Moves preserve existing grants and stable IDs.',
			inputSchema: fileManageSchema,
			outputSchema: z.object({ file: fileMetadataSchema }),
			handler: (args, ctx) => manageFile(ctx, args),
		}),
		defineDomainCapability(domain, {
			...common,
			name: 'fileDelete',
			orgPermission: 'file:delete',
			readOnly: false,
			destructive: true,
			description:
				'Permanently delete a file and all its revisions. Its id cannot be reused.',
			inputSchema: z.object({ file_id: fileIdSchema }),
			outputSchema: z.object({ ok: z.literal(true) }),
			handler: (args, ctx) => deleteFile(ctx, args.file_id),
		}),
	],
})
