import { z } from 'zod'

export const workspaceDirectoryMediaType = 'application/vnd.kody.directory'

export function isWorkspaceContainer(mediaType: string) {
	return (
		mediaType === workspaceDirectoryMediaType ||
		mediaType === workspacePageMediaType
	)
}

export const workspacePageMediaType = 'application/vnd.kody.page+json'
const pageTextKinds = [
	'paragraph',
	'heading',
	'bullet',
	'task',
	'quote',
	'code',
] as const
const blockId = z.string().uuid()
const pageBlockSchema = z.union([
	z.object({
		id: blockId,
		kind: z.enum(pageTextKinds),
		text: z.string(),
		checked: z.boolean().optional(),
	}),
	z.object({ id: blockId, kind: z.literal('file'), fileId: blockId }),
])
const pageSchema = z
	.object({
		version: z.literal(1),
		blocks: z.array(pageBlockSchema).max(250),
	})
	.refine(
		({ blocks }) => new Set(blocks.map(({ id }) => id)).size === blocks.length,
	)

export type PageBlock = z.infer<typeof pageBlockSchema>

export function readWorkspacePage(content: string) {
	try {
		const result = pageSchema.safeParse(JSON.parse(content))
		return result.success ? result.data : null
	} catch {
		return null
	}
}

export function writeWorkspacePage(blocks: PageBlock[]) {
	return JSON.stringify({ version: 1, blocks })
}

const pageEditSchema = z.discriminatedUnion('kind', [
	z.object({
		kind: z.literal('insert'),
		after_id: blockId.nullable(),
		block: pageBlockSchema,
	}),
	z.object({ kind: z.literal('replace'), block: pageBlockSchema }),
	z.object({ kind: z.literal('remove'), block_id: blockId }),
	z.object({
		kind: z.literal('move'),
		block_id: blockId,
		after_id: blockId.nullable(),
	}),
])
export const pagePatchSchema = z.object({
	file_id: blockId,
	write_id: blockId,
	base_revision_id: blockId,
	operations: z.array(pageEditSchema).min(1).max(100),
})

/** Apply a batch to a copy. Missing anchors and duplicate IDs fail the entire batch. */
export function patchWorkspacePage(
	content: string,
	operations: z.infer<typeof pagePatchSchema>['operations'],
) {
	const page = readWorkspacePage(content)
	if (!page) throw new Error('Invalid workspace page contents.')
	const blocks = [...page.blocks]
	for (const operation of operations) {
		if (
			operation.kind === 'remove' ||
			operation.kind === 'replace' ||
			operation.kind === 'move'
		) {
			const id =
				operation.kind === 'replace' ? operation.block.id : operation.block_id
			const index = blocks.findIndex((block) => block.id === id)
			if (index < 0) throw new Error('Page block not found: ' + id)
			if (operation.kind === 'replace') {
				blocks[index] = operation.block
				continue
			}
			if (operation.kind === 'remove') {
				blocks.splice(index, 1)
				continue
			}
			if (operation.after_id === id)
				throw new Error('A page block cannot move after itself.')
			const [moving] = blocks.splice(index, 1)
			const destination =
				operation.after_id === null
					? -1
					: blocks.findIndex((block) => block.id === operation.after_id)
			if (operation.after_id !== null && destination < 0)
				throw new Error('Page block destination not found.')
			blocks.splice(destination + 1, 0, moving!)
		} else {
			if (blocks.some((block) => block.id === operation.block.id))
				throw new Error('Page block ID already exists.')
			const destination =
				operation.after_id === null
					? -1
					: blocks.findIndex((block) => block.id === operation.after_id)
			if (operation.after_id !== null && destination < 0)
				throw new Error('Page block destination not found.')
			blocks.splice(destination + 1, 0, operation.block)
		}
	}
	return JSON.stringify(pageSchema.parse({ version: 1, blocks }))
}

function markdownText(text: string) {
	return text
		.replace(/[\\\x60*_{}[\]<>#!|]/g, '\\$&')
		.replace(/^(\s*)([-+]|\d+\.) /gm, '$1\\$2 ')
}

/** A readable export. Asset links keep their original IDs and access checks. */
export function workspacePageMarkdown(
	title: string,
	content: string,
	files: Array<{ id: string; name: string; href: string }>,
) {
	const page = readWorkspacePage(content)
	if (!page) throw new Error('Invalid workspace page contents.')
	const assets = new Map(files.map((file) => [file.id, file]))
	const rendered = page.blocks.map((block) => {
		if (block.kind === 'file') {
			const asset = assets.get(block.fileId)
			return asset
				? `[${markdownText(asset.name).replaceAll('\n', ' ')}](<${asset.href.replaceAll('>', '%3E')}>)`
				: 'Attachment unavailable'
		}
		if (block.kind === 'code') {
			const longest = Math.max(
				0,
				...(block.text.match(/`+/g) ?? []).map((run) => run.length),
			)
			const fence = '`'.repeat(Math.max(3, longest + 1))
			return `${fence}\n${block.text}\n${fence}`
		}
		const text = markdownText(block.text)
		if (block.kind === 'heading') return '## ' + text.replaceAll('\n', ' ')
		if (block.kind === 'quote')
			return text
				.split('\n')
				.map((line) => '> ' + line)
				.join('\n')
		if (block.kind === 'bullet' || block.kind === 'task') {
			const prefix =
				block.kind === 'bullet' ? '- ' : block.checked ? '- [x] ' : '- [ ] '
			return prefix + text.replaceAll('\n', '\n' + ' '.repeat(prefix.length))
		}
		return text
	})
	return (
		'# ' +
		markdownText(title).replaceAll('\n', ' ') +
		'\n\n' +
		rendered.join('\n\n') +
		'\n'
	)
}
