import { z } from 'zod'
import { publishOffloadLimits } from './policy.ts'
import type { PublishBuildDocument } from './types.ts'

const sha256 = z
	.string()
	.regex(/^[0-9a-f]{64}$/, 'must be a lowercase sha256 hex digest')
const byteSize = z.number().int().nonnegative()

const fileEntry = z.object({
	path: z.string().min(1),
	size: byteSize,
	sha256,
})

/** A module is split into `chunkBytes` pieces, so its size bounds its chunk list. */
const moduleEntry = z
	.object({
		sha256,
		size: byteSize.max(publishOffloadLimits.maxTargetBytes),
		chunks: z.array(sha256).min(1),
	})
	.refine(
		(module) =>
			module.chunks.length <=
			Math.max(1, Math.ceil(module.size / publishOffloadLimits.chunkBytes)),
		{ message: 'lists more chunks than its size needs', path: ['chunks'] },
	)

const targetEntry = z
	.object({
		kind: z.string().min(1),
		bundleKind: z.enum(['app', 'app-client', 'module', 'importable-module']),
		artifactName: z.string().nullable(),
		entryPoint: z.string().min(1),
		mainModule: z.string().min(1),
		modules: z.record(z.string(), moduleEntry),
	})
	.refine((target) => Object.hasOwn(target.modules, target.mainModule), {
		message: 'must name one of the uploaded modules',
		path: ['mainModule'],
	})

/** The sealed build document as a builder uploads it; decoded at the edge. */
export const publishBuildDocumentSchema = z.object({
	builderVersion: z.number().int(),
	commit: z.string(),
	files: z.array(fileEntry),
	targets: z.array(targetEntry),
	buildMs: z.number().optional(),
}) satisfies z.ZodType<PublishBuildDocument>
