import { fileCollaborationEnabled } from './feature.ts'
import { z } from 'zod'
import { fileIdSchema } from '#universal/files.ts'
import {
	readWorkspacePage,
	workspacePageMediaType,
} from '#universal/workspace-page.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import {
	requireMcpRequest,
	requireMcpUser,
} from '#mcp/capabilities/meta/require-user.ts'
import {
	resolvePublicFileScope,
	readScopedPublishedFile,
} from './public-links.ts'
import {
	openPublicCopyPlan,
	sealPublicCopyPlan,
	copiedContent,
} from './public-copy.ts'
import { fileStoreRpc } from './client.ts'
import { writeFile } from './service.ts'

export const publicCopySourceSchema = z.object({
	orgSlug: z.string().regex(/^[a-zA-Z0-9_-]+$/),
	rootId: fileIdSchema,
	token: z.string().regex(/^[a-f0-9]{64}$/),
	itemId: fileIdSchema,
})
export const publicCopyStepSchema = z.object({
	ticket: z.string().max(200_000),
	index: z.number().int().min(0).max(127),
})

export async function prepareSharedCopy(
	ctx: CapabilityContext,
	data: z.infer<typeof publicCopySourceSchema>,
) {
	const request = requireMcpRequest(ctx.callerContext)
	const user = requireMcpUser(ctx.callerContext)
	if (!(await fileCollaborationEnabled(ctx.env, request)))
		throw new Error('Files is unavailable in this workspace.')
	const initial = await resolvePublicFileScope(
		ctx.env,
		data.orgSlug,
		data.rootId,
		data.token,
		data.itemId,
	)
	const visible = new Map(initial.files.map((file) => [file.id, file]))
	const queue = [data.itemId],
		seen = new Set<string>(),
		documents = []
	for (let i = 0; i < queue.length; i++) {
		const id = queue[i]!
		if (seen.has(id) || !visible.has(id)) continue
		seen.add(id)
		if (seen.size > 128)
			throw new Error(
				'Save up to 128 items at a time. Open a smaller folder to copy it.',
			)
		const file = await readScopedPublishedFile(
			ctx.env,
			initial.ownerId,
			visible.get(id)!,
		)
		if (!file.revisionId)
			throw new Error('This file is not ready to copy. Try again.')
		const { content, ...metadata } = file
		documents.push(metadata)
		for (const child of initial.files)
			if (child.parentId === id) queue.push(child.id)
		const page =
			file.mediaType === workspacePageMediaType
				? readWorkspacePage(content)
				: null
		if (page)
			for (const block of page.blocks)
				if (block.kind === 'file' && visible.has(block.fileId))
					queue.push(block.fileId)
	}
	const ids = new Map(documents.map((file) => [file.id, crypto.randomUUID()]))
	const entries = documents.map((file) => ({
		sourceId: file.id,
		targetId: ids.get(file.id)!,
		writeId: crypto.randomUUID(),
		parentId:
			file.id === data.itemId
				? undefined
				: (ids.get(file.parentId ?? '') ?? ids.get(data.itemId)),
		revisionId: file.revisionId!,
		name: file.name,
		mediaType: file.mediaType,
		encoding: file.encoding,
	}))
	// Parent creation must precede children, including assets embedded outside the selected subtree.
	const ordered: typeof entries = [],
		remaining = [...entries]
	while (remaining.length) {
		const index = remaining.findIndex(
			(entry) =>
				!entry.parentId ||
				ordered.some((parent) => parent.targetId === entry.parentId),
		)
		if (index < 0) throw new Error('This folder hierarchy cannot be copied.')
		ordered.push(remaining.splice(index, 1)[0]!)
	}
	const plan = {
		subject: user.userId,
		destination: request.org.slug!,
		expires: Date.now() + 60 * 60 * 1000,
		...data,
		entries: ordered,
	}
	const ticket = await sealPublicCopyPlan(ctx.env, request.org.id, plan)
	// No source content, comments, grants, or credentials are returned to the client.
	return {
		ticket,
		count: entries.length,
		name: initial.file.name,
		destination: request.org.slug!,
		fileId: ids.get(data.itemId)!,
	}
}

export async function copySharedItem(
	ctx: CapabilityContext,
	data: z.infer<typeof publicCopyStepSchema>,
) {
	const request = requireMcpRequest(ctx.callerContext)
	const user = requireMcpUser(ctx.callerContext)
	if (!(await fileCollaborationEnabled(ctx.env, request)))
		throw new Error('Files is unavailable in this workspace.')
	const plan = await openPublicCopyPlan(
		ctx.env,
		request.org.id,
		user.userId,
		data.ticket,
	)
	if (
		plan.subject !== user.userId ||
		plan.destination !== request.org.slug ||
		plan.expires <= Date.now()
	)
		throw new Error('This copy session expired. Start a new copy.')
	const entry = plan.entries[data.index]
	if (!entry) throw new Error('Copy item not found.')
	// Recheck revocation, current ancestry and restrictions before every item, even on retry.
	const visible = await resolvePublicFileScope(
		ctx.env,
		plan.orgSlug,
		plan.rootId,
		plan.token,
		entry.sourceId,
	)
	const source = await fileStoreRpc(ctx.env, visible.ownerId).read(
		visible.ownerId,
		entry.sourceId,
		entry.revisionId,
	)
	const result = await writeFile(ctx, {
		file_id: entry.targetId,
		write_id: entry.writeId,
		name: entry.name,
		parent_id: entry.parentId,
		media_type: entry.mediaType,
		encoding: entry.encoding,
		content: copiedContent(entry.mediaType, source.content, plan.entries),
	})
	if (!result.ok) throw new Error('The copy changed. Start a new copy.')
	return { ok: true as const }
}
