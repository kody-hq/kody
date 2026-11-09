import { sealFileShareValue, openFileShareValue } from '#mcp/secrets/crypto.ts'
import { z } from 'zod'
import { fileIdSchema } from '#universal/files.ts'
import {
	readWorkspacePage,
	writeWorkspacePage,
	workspacePageMediaType,
} from '#universal/workspace-page.ts'

const entrySchema = z.object({
	sourceId: fileIdSchema,
	targetId: fileIdSchema,
	writeId: fileIdSchema,
	parentId: fileIdSchema.optional(),
	revisionId: fileIdSchema,
	name: z.string(),
	mediaType: z.string(),
	encoding: z.enum(['utf8', 'base64']).optional(),
})
const publicCopyPlanSchema = z.object({
	subject: z.string(),
	destination: z.string(),
	expires: z.number(),
	orgSlug: z.string(),
	rootId: fileIdSchema,
	token: z.string(),
	entries: z.array(entrySchema).min(1).max(128),
})
type PublicCopyPlan = z.infer<typeof publicCopyPlanSchema>

/** Only copied assets retain embeds. A copy never refers back to private source IDs. */
export function copyPageContent(
	content: string,
	entries: PublicCopyPlan['entries'],
) {
	const page = readWorkspacePage(content)
	if (!page)
		throw new Error(
			'This page cannot be copied because its content is invalid.',
		)
	const targets = new Map(
		entries.map((entry) => [entry.sourceId, entry.targetId]),
	)
	return writeWorkspacePage(
		page.blocks.map((block) =>
			block.kind !== 'file'
				? block
				: targets.has(block.fileId)
					? { ...block, fileId: targets.get(block.fileId)! }
					: {
							id: block.id,
							kind: 'paragraph',
							text: 'File not included in this shared copy.',
						},
		),
	)
}
export function copiedContent(
	mediaType: string,
	content: string,
	entries: PublicCopyPlan['entries'],
) {
	return mediaType === workspacePageMediaType
		? copyPageContent(content, entries)
		: content
}

export function sealPublicCopyPlan(
	env: Pick<Env, 'SECRET_STORE_KEY'>,
	destinationOwnerId: string,
	plan: PublicCopyPlan,
) {
	return sealFileShareValue(
		env,
		'copy-plan',
		`${destinationOwnerId}:${plan.subject}`,
		JSON.stringify(plan),
	)
}
export async function openPublicCopyPlan(
	env: Pick<Env, 'SECRET_STORE_KEY'>,
	destinationOwnerId: string,
	subject: string,
	ticket: string,
) {
	return publicCopyPlanSchema.parse(
		JSON.parse(
			await openFileShareValue(
				env,
				'copy-plan',
				`${destinationOwnerId}:${subject}`,
				ticket,
			),
		),
	)
}
