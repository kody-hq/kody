import { z } from 'zod'
import { credentialNeedChangeSchema } from '#mcp/capabilities/packages/shared.ts'
import {
	packageIdLookupDescription,
	packageNameLookupDescription,
} from '#worker/package-registry/package-name.ts'
import {
	entityKindValues,
	repoSessionStatusValues,
} from '#worker/repo/types.ts'

export const repoSearchModeSchema = z.enum(['literal', 'regex'])
export const repoSearchOutputModeSchema = z.enum(['content', 'files'])

const repoTargetShapeSchema = z.union([
	z.object({
		kind: z.literal('package'),
		package_id: z.string().min(1).describe(packageIdLookupDescription),
	}),
	z.object({
		kind: z.literal('package'),
		kody_id: z.string().min(1).describe(packageNameLookupDescription),
	}),
	z.object({
		kind: z.literal('repo'),
		repo_id: z
			.string()
			.min(1)
			.describe('Plain repo id to open or edit by stable identifier.'),
	}),
	z.object({
		kind: z.literal('repo'),
		name: z
			.string()
			.min(1)
			.describe('Plain repo name to open or edit by user-facing identity.'),
	}),
])

/**
 * Agents routinely guess camelCase (`kodyId`, `packageId`) for the snake_case
 * target fields and burn a round trip on the validation error, so the schema
 * accepts both spellings and normalizes to snake_case.
 */
function normalizeRepoTargetAliases(value: unknown) {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return value
	}
	const record = value as Record<string, unknown>
	const normalized: Record<string, unknown> = { ...record }
	if (normalized['package_id'] === undefined && 'packageId' in record) {
		normalized['package_id'] = record['packageId']
		delete normalized['packageId']
	}
	if (normalized['kody_id'] === undefined && 'kodyId' in record) {
		normalized['kody_id'] = record['kodyId']
		delete normalized['kodyId']
	}
	if (normalized['repo_id'] === undefined && 'repoId' in record) {
		normalized['repo_id'] = record['repoId']
		delete normalized['repoId']
	}
	return normalized
}

export const repoTargetSchema = z.preprocess(
	normalizeRepoTargetAliases,
	repoTargetShapeSchema,
)

export const repoResolvedTargetSchema = z.union([
	z.object({
		kind: z.literal('source'),
		source_id: z.string(),
		entity_kind: z.enum(entityKindValues),
		entity_id: z.string(),
	}),
	z.object({
		kind: z.literal('package'),
		source_id: z.string(),
		package_id: z.string(),
		kody_id: z.string(),
		name: z.string(),
	}),
	z.object({
		kind: z.literal('repo'),
		source_id: z.string(),
		repo_id: z.string(),
		name: z.string(),
	}),
])

/**
 * Agents sometimes pass literal placeholders (`none`, `null`, …) when they do
 * not have a session id yet. Reject those at the schema boundary with guidance
 * so the mistake never reaches the RepoSession DO or Sentry (KODY-CLOUDFLARE-5V).
 */
const repoSessionIdPlaceholderValues = new Set([
	'none',
	'null',
	'undefined',
	'nil',
	'n/a',
	'na',
])

export const repoSessionIdFieldSchema = z
	.string()
	.min(1)
	.refine(
		(value) => !repoSessionIdPlaceholderValues.has(value.trim().toLowerCase()),
		{
			message:
				'session_id must be a real id from repoOpenSession or repoListSessions, not a placeholder like "none".',
		},
	)
	.describe('Active repo session id from repoOpenSession or repoListSessions.')

export const repoSessionIdSchema = z.object({
	session_id: repoSessionIdFieldSchema,
})

export const repoPublishSessionInputSchema = repoSessionIdSchema.extend({
	confirm_private_visibility_change: z
		.boolean()
		.optional()
		.default(false)
		.describe(
			'Unused. Visibility is a repo setting via packageUpdate, not package.json#private.',
		),
	absorbed_upstream_commit: z
		.string()
		.min(1)
		.optional()
		.describe(
			'When publishing a community fork after porting (or skipping) origin updates, pass origin HEAD so the behind-upstream banner clears. Does not copy files.',
		),
})

export const repoOpenSessionInputSchema = z
	.object({
		source_id: z
			.string()
			.min(1)
			.optional()
			.describe(
				'Shared source id to open a session for. Prefer `target` when you know the saved package identity instead of the internal source id.',
			),
		target: repoTargetSchema
			.optional()
			.describe(
				'User-facing repo-backed package identity. Use this instead of `source_id` when opening a saved package session.',
			),
		conversation_id: z
			.string()
			.min(1)
			.optional()
			.describe(
				'Optional conversation id to associate with this repo session for default resolution in later calls.',
			),
		source_root: z
			.string()
			.min(1)
			.optional()
			.describe(
				'Optional repo subdirectory to treat as the working source root.',
			),
		default_branch: z
			.string()
			.min(1)
			.optional()
			.describe('Optional default branch name hint for session creation.'),
	})
	.superRefine((value, ctx) => {
		const sourceRefCount =
			(value.source_id !== undefined ? 1 : 0) +
			(value.target !== undefined ? 1 : 0)
		if (sourceRefCount !== 1) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['source_id'],
				message: 'Provide exactly one of `source_id` or `target`.',
			})
		}
	})

export const repoSourceRefSchema = z.object({
	source_id: z
		.string()
		.min(1)
		.describe('Shared source id to open a session for.'),
})

export const repoSessionInfoSchema = z.object({
	id: z.string(),
	source_id: z.string(),
	source_root: z.string(),
	base_commit: z.string(),
	session_branch: z.string(),
	source_branch: z.string(),
	conversation_id: z.string().nullable(),
	last_checkpoint_commit: z.string().nullable(),
	last_check_run_id: z.string().nullable(),
	last_check_tree_hash: z.string().nullable(),
	expires_at: z.string().nullable(),
	created_at: z.string(),
	updated_at: z.string(),
	published_commit: z.string().nullable(),
	manifest_path: z.string(),
	entity_type: z.enum(entityKindValues),
})

export const repoListSessionStatusValues = [
	...repoSessionStatusValues,
	'all',
] as const

export const repoListSessionStatusSchema = z.enum(repoListSessionStatusValues)

export const repoListSessionsInputSchema = z.object({
	status: repoListSessionStatusSchema
		.optional()
		.default('active')
		.describe(
			'Which repo session lifecycle status to include. Defaults to active sessions.',
		),
	source_id: z
		.string()
		.min(1)
		.optional()
		.describe('Optional repo-backed source id to narrow the session list.'),
	limit: z
		.number()
		.int()
		.min(1)
		.max(100)
		.optional()
		.default(100)
		.describe('Maximum sessions to return. Capped at 100.'),
})

export const repoListSessionInfoSchema = repoSessionInfoSchema.extend({
	status: z.enum(repoSessionStatusValues),
	resolved_target: repoResolvedTargetSchema,
})

export const repoListSessionsOutputSchema = z.object({
	sessions: z.array(repoListSessionInfoSchema),
})

export const repoOpenSessionOutputSchema = repoSessionInfoSchema.extend({
	resolved_target: repoResolvedTargetSchema,
})

export const repoReadFileInputSchema = repoSessionIdSchema.extend({
	path: z
		.string()
		.min(1)
		.describe(
			'Repo-relative file path to read. Append #L165, #L165-L180, or a Markdown heading slug (#export-jsdoc) to return that region. A missing anchor fails instead of returning the whole file.',
		),
})

export const repoReadFileAnchorSchema = z.object({
	kind: z.enum(['lines', 'heading']),
	requested: z.string(),
	start_line: z.number().int(),
	end_line: z.number().int(),
	requested_start_line: z.number().int(),
	requested_end_line: z.number().int(),
	total_lines: z.number().int(),
	heading: z
		.object({
			title: z.string(),
			slug: z.string(),
			level: z.number().int(),
		})
		.nullable(),
})

export const repoReadFileOutputSchema = z.object({
	path: z.string(),
	content: z.string().nullable(),
	anchor: repoReadFileAnchorSchema
		.optional()
		.describe(
			'Set when path included a # fragment. start_line/end_line are the returned window; a single #L165 line includes surrounding context.',
		),
})

export const repoWriteFileEditSchema = z.object({
	path: z.string(),
	changed: z.boolean(),
	content: z.string(),
	diff: z.string(),
})

export const repoWriteFileOutputSchema = z.object({
	dry_run: z.boolean(),
	total_changed: z.number().int().min(0),
	edits: z.array(repoWriteFileEditSchema),
})

const repoSessionEditSchema = z.discriminatedUnion('kind', [
	z.object({
		kind: z.literal('write'),
		path: z
			.string()
			.min(1)
			.describe(
				'Repo-relative file path to write. Existing files are overwritten; missing parent directories are created.',
			),
		content: z
			.string()
			.describe(
				'Full new file content. Pass the entire file body, not a patch or diff. Empty string clears the file.',
			),
	}),
	z.object({
		kind: z.literal('replace'),
		path: z.string().min(1),
		search: z.string(),
		replacement: z.string().optional(),
		options: z
			.object({
				case_sensitive: z.boolean().optional(),
				regex: z.boolean().optional(),
				whole_word: z.boolean().optional(),
				context_before: z.number().int().min(0).optional(),
				context_after: z.number().int().min(0).optional(),
				max_matches: z.number().int().min(1).optional(),
				spaces: z.number().int().optional(),
			})
			.optional(),
	}),
	z.object({
		kind: z.literal('writeJson'),
		path: z.string().min(1),
		value: z.unknown(),
		options: z
			.object({
				spaces: z.number().int().optional(),
			})
			.optional(),
	}),
	z.object({
		kind: z.literal('delete'),
		path: z.string().min(1),
	}),
	z.object({
		kind: z.literal('move'),
		path: z.string().min(1),
		to: z.string().min(1),
	}),
])

export const repoEditFilesInputSchema = repoSessionIdSchema.extend({
	edits: z
		.array(repoSessionEditSchema)
		.min(1)
		.describe(
			'Batch of file-level edits: write, replace, writeJson, delete, or move. Multiple content edits to the same path compose sequentially.',
		),
	dry_run: z
		.boolean()
		.optional()
		.describe('Preview edits without mutating the workspace.'),
	rollback_on_error: z
		.boolean()
		.optional()
		.describe(
			'When true (default), roll back the batch if any edit fails. Set false to keep partial progress.',
		),
})

export const repoEditFilesOutputSchema = repoWriteFileOutputSchema

export const repoApplyPatchInputSchema = repoSessionIdSchema.extend({
	patch: z
		.string()
		.min(1)
		.describe(
			'Standard unified diff to apply. Multiple file patches can be stacked in one patch string.',
		),
	dry_run: z
		.boolean()
		.optional()
		.describe('Preview patch application without writing files.'),
})

export const repoApplyPatchOutputSchema = repoWriteFileOutputSchema

export const repoStatusOutputSchema = z.object({
	status: z.unknown(),
})

export const repoDiffOutputSchema = z.object({
	diff: z.unknown(),
})

export const repoLogInputSchema = repoSessionIdSchema.extend({
	depth: z
		.number()
		.int()
		.min(1)
		.optional()
		.describe('Optional maximum number of commits to return.'),
})

export const repoLogOutputSchema = z.object({
	log: z.unknown(),
})

export const repoCommitInputSchema = repoSessionIdSchema.extend({
	message: z
		.string()
		.trim()
		.min(1)
		.describe('Commit message. Whitespace-only messages are rejected.'),
})

export const repoCommitOutputSchema = z.object({
	oid: z.string(),
	message: z.string(),
})

export const repoRestoreInputSchema = repoSessionIdSchema.extend({
	paths: z
		.array(z.string().min(1))
		.min(1)
		.describe('Repo-relative workspace paths to restore.'),
	commit: z
		.string()
		.min(1)
		.optional()
		.describe(
			'Commit to restore from. Defaults to the session base commit (HEAD at open).',
		),
})

export const repoRestoreOutputSchema = z.object({
	commit: z.string(),
	restored: z.array(z.string()),
})

export const repoTreeInputSchema = repoSessionIdSchema.extend({
	path: z
		.string()
		.min(1)
		.optional()
		.describe(
			'Optional repo-relative directory path. Defaults to the repo session source root.',
		),
	max_depth: z
		.number()
		.int()
		.min(0)
		.optional()
		.describe('Optional maximum tree depth to include in the result.'),
})

export const repoTreeNodeSchema: z.ZodType<unknown> = z.lazy(() =>
	z.object({
		path: z.string(),
		name: z.string(),
		type: z.enum(['file', 'directory', 'symlink']),
		size: z.number().int().min(0),
		children: z.array(repoTreeNodeSchema).optional(),
	}),
)

export const repoSearchInputSchema = repoSessionIdSchema.extend({
	pattern: z
		.string()
		.min(1)
		.describe(
			'Literal text or regex to search for. In regex mode this must be valid JavaScript RegExp syntax (no Python/PCRE inline flags such as (?s) or (?i)).',
		),
	mode: repoSearchModeSchema
		.optional()
		.describe(
			'Search mode. Defaults to literal. regex uses JavaScript RegExp syntax.',
		),
	glob: z
		.string()
		.min(1)
		.optional()
		.describe('Optional glob filter for files to search.'),
	path: z
		.string()
		.min(1)
		.optional()
		.describe('Optional repo-relative subpath to scope the search to.'),
	case_sensitive: z
		.boolean()
		.optional()
		.describe('Whether matching should be case-sensitive.'),
	before: z
		.number()
		.int()
		.min(0)
		.optional()
		.describe('Lines of context to include before each match.'),
	after: z
		.number()
		.int()
		.min(0)
		.optional()
		.describe('Lines of context to include after each match.'),
	limit: z
		.number()
		.int()
		.min(1)
		.optional()
		.describe('Maximum number of matches to return before truncation.'),
	output_mode: repoSearchOutputModeSchema
		.optional()
		.describe('Whether to return match content or just files with matches.'),
})

export const repoSearchMatchSchema = z.object({
	line: z.number().int().min(1),
	column: z.number().int().min(1),
	match: z.string(),
	lineText: z.string(),
	beforeLines: z.array(z.string()),
	afterLines: z.array(z.string()),
})

export const repoSearchFileMatchSchema = z.object({
	path: z.string(),
	matches: z.array(repoSearchMatchSchema),
})

export const repoSearchOutputSchema = z.object({
	files: z.array(repoSearchFileMatchSchema),
	total_files: z.number().int().min(0),
	total_matches: z.number().int().min(0),
	output_mode: repoSearchOutputModeSchema,
	truncated: z.boolean(),
})

export const repoDiscardSessionOutputSchema = z.object({
	ok: z.literal(true),
	session_id: z.string(),
	deleted: z.boolean(),
})

export const repoCheckResultSchema = z.object({
	kind: z.enum([
		'manifest',
		'docs',
		'skills',
		'dependencies',
		'bundle',
		'typecheck',
		'lint',
		'credentials',
		'smoke',
	]),
	ok: z.boolean(),
	message: z.string(),
})

export const repoRunChecksOutputSchema = z.object({
	ok: z.boolean(),
	results: z.array(repoCheckResultSchema),
	manifest: z
		.object({
			name: z.string(),
			kody_id: z.string(),
			description: z.string(),
			has_app: z.boolean(),
		})
		.nullable()
		.describe(
			'Parsed package.json summary when available; null when the manifest itself failed validation or was missing.',
		),
})

type RepoManifestSummaryInput = {
	name?: unknown
	title?: unknown
	description?: unknown
	kody?: {
		id?: unknown
		description?: unknown
		app?: unknown
	}
}

type RepoManifestSummary = {
	name: string
	kody_id: string
	description: string
	has_app: boolean
}

export function normalizeRepoManifestSummary(manifest: null): null
export function normalizeRepoManifestSummary(
	manifest: RepoManifestSummaryInput,
): RepoManifestSummary
export function normalizeRepoManifestSummary(
	manifest: RepoManifestSummaryInput | null,
): RepoManifestSummary | null
export function normalizeRepoManifestSummary(
	manifest: RepoManifestSummaryInput | null,
): RepoManifestSummary | null {
	if (manifest == null) return null
	const packageName =
		typeof manifest.name === 'string'
			? manifest.name
			: typeof manifest.title === 'string'
				? manifest.title
				: 'package'
	const kodyId =
		typeof manifest.kody?.id === 'string' ? manifest.kody.id : packageName
	const description =
		typeof manifest.kody?.description === 'string'
			? manifest.kody.description
			: typeof manifest.description === 'string'
				? manifest.description
				: ''
	return {
		name: packageName,
		kody_id: kodyId,
		description,
		has_app: manifest.kody?.app !== undefined,
	}
}

export const repoPublishSessionOutputSchema = z.discriminatedUnion('status', [
	z.object({
		status: z.literal('ok'),
		session_id: z.string(),
		published_commit: z.string(),
		message: z.string(),
		package_shaped: z.boolean().optional(),
		notice: z.string().nullable().optional(),
	}),
	z.object({
		status: z.literal('checks_outdated'),
		session_id: z.string(),
		published_commit: z.null(),
		message: z.string(),
	}),
	z.object({
		status: z.literal('base_moved'),
		session_id: z.string(),
		published_commit: z.null(),
		message: z.string(),
		repair_hint: z.literal('repoRebaseSession'),
		session_base_commit: z.string(),
		current_published_commit: z.string().nullable(),
	}),
	z.object({
		status: z.literal('locked'),
		session_id: z.string(),
		published_commit: z.null(),
		pending_commit: z
			.string()
			.describe('Full 40-character SHA-1 to promote. Do not abbreviate it.'),
		current_published_commit: z.string().nullable(),
		approval_url: z
			.string()
			.describe(
				'Owner page for pending_commit. The commit query is that full 40-character SHA-1.',
			),
		message: z.string(),
	}),
	z.object({
		status: z.literal('approval_required'),
		session_id: z.string(),
		published_commit: z.null(),
		pending_commit: z.string(),
		current_published_commit: z.string().nullable(),
		approval_url: z.string(),
		approval_bundle_url: z
			.string()
			.optional()
			.describe(
				'Present when other paused publishes also wait on the owner: one page that approves them together.',
			),
		credential_need_changes: z.array(credentialNeedChangeSchema),
		message: z.string(),
	}),
])

export const repoCheckStatusOutputSchema = z.object({
	run_id: z.string().nullable(),
	tree_hash: z.string().nullable(),
	checked_at: z.string().nullable(),
	ok: z.boolean(),
	results: z.array(repoCheckResultSchema),
})
