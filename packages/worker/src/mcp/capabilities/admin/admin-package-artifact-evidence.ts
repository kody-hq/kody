import { z } from 'zod'
import { McpCallerError } from '#mcp/caller-error.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	loadPackageArtifactEvidence,
	PackageArtifactEvidenceCursorError,
	packageArtifactEvidenceDefaultLimit,
	packageArtifactEvidenceMaxLimit,
} from '#worker/admin/package-artifact-evidence.ts'
import {
	adminCapabilityAccess,
	auditAdminCapabilityInvocation,
} from './admin-shared.ts'

const inputSchema = z
	.object({
		packageId: z
			.string()
			.trim()
			.min(1)
			.optional()
			.describe('Saved package id (UUID) of any owner.'),
		packageName: z
			.string()
			.trim()
			.regex(/^@[^/\s]+\/[^/\s]+$/, 'Expected @owner/name.')
			.optional()
			.describe('Scoped package name, @owner/name.'),
		limit: z
			.number()
			.int()
			.min(1)
			.max(packageArtifactEvidenceMaxLimit)
			.optional()
			.describe(
				`Targets per page (default ${packageArtifactEvidenceDefaultLimit}, max ${packageArtifactEvidenceMaxLimit}).`,
			),
		cursor: z
			.string()
			.trim()
			.optional()
			.describe(
				'page.nextCursor from the previous page. Refused when the package state changed between pages; restart without a cursor.',
			),
	})
	.refine(
		(value) =>
			[value.packageId, value.packageName].filter(Boolean).length === 1,
		{ message: 'Provide exactly one of packageId or packageName.' },
	)

const nullableString = z.string().nullable()
const payloadStatusSchema = z.enum([
	'valid',
	'missing',
	'malformed',
	'identity_mismatch',
	'kv_unavailable',
])
const payloadFields = {
	commit: nullableString.describe('Commit this KV key is keyed by.'),
	kvKey: nullableString.describe(
		'KV key the reader reads. Null when the stored identity-row key is not the derived commit-keyed form (kvKeyDerived false).',
	),
	kvKeyDerived: z.boolean(),
	status: payloadStatusSchema,
	malformedReason: z
		.enum([
			'invalid_json',
			'not_object',
			'unsupported_version',
			'invalid_modules',
		])
		.nullable(),
	identityMismatchFields: z
		.array(z.string())
		.describe('Identity fields the payload disagrees on (names only).'),
	embeddedCommit: nullableString.describe(
		'publishedCommit embedded in the payload, when it is a commit SHA.',
	),
	embeddedCommitMatches: z.boolean().nullable(),
	mainModule: nullableString,
	mainModuleSha256: nullableString,
	bundleSha256: nullableString.describe(
		'SHA-256 over the main module name and sorted module path/hash pairs.',
	),
	moduleCount: z.number().nullable(),
	modulesTruncated: z.boolean(),
	sizeBytes: z.number().nullable(),
}
const payloadSchema = z.object({
	...payloadFields,
	modules: z.array(z.object({ path: z.string(), sha256: z.string() })),
})

const outputSchema = z.object({
	package: z.object({
		packageId: z.string(),
		name: z.string(),
		ownerId: z.string(),
		sourceId: z.string(),
	}),
	source: z
		.object({
			publishedCommit: nullableString,
			servingCommit: nullableString,
			servingArtifactCommit: nullableString,
		})
		.nullable(),
	manifest: z.object({
		status: z
			.enum(['loaded', 'snapshot_missing', 'unavailable'])
			.describe(
				'Declared targets come from the KV manifest snapshot only (never recovered or written on read). snapshot_missing and unavailable fall back to identity rows and jobs.',
			),
		commit: nullableString.describe(
			'Commit the declared targets were read from (the serving commit).',
		),
	}),
	targets: z.array(
		z.object({
			key: z.string(),
			kind: z.enum(['app', 'app-client', 'importable-module', 'job', 'module']),
			artifactName: nullableString,
			entryPoint: nullableString,
			declared: z
				.boolean()
				.describe('Declared by the serving-commit manifest.'),
			selector: z
				.enum(['serving_commit', 'serving_artifact_commit'])
				.describe('Which source pointer the runtime reader passes.'),
			identityRow: z
				.object({
					builtFromCommit: z.string(),
					builtFromCommitValid: z.boolean(),
					updatedAt: z.string(),
				})
				.nullable()
				.describe('Newest-build identity row (published_bundle_artifacts).'),
			selected: payloadSchema
				.nullable()
				.describe('Payload a runtime reader selects for this target.'),
			servedFrom: z
				.enum(['template', 'identity_row', 'none'])
				.describe(
					'Stored bytes runtime serves: the app publish-time worker template (read first), the identity-row path, or none.',
				),
			runtimeLoads: z.boolean(),
			template: payloadSchema
				.nullable()
				.describe('App only: publish-time worker template payload.'),
			clientPointer: z
				.object({
					kvKey: z.string(),
					status: payloadStatusSchema,
					mainModule: nullableString,
					matchesSelectedMainModule: z.boolean().nullable(),
				})
				.nullable()
				.describe(
					'App client only: template client pointer (picks the client module URL; bytes still come from selected).',
				),
			newestRow: z
				.object(payloadFields)
				.nullable()
				.describe(
					'Payload at the newest identity row commit, only when it differs from the selected commit.',
				),
			selectedMatchesNewestRowBytes: z.boolean().nullable(),
			jobs: z.array(
				z.object({
					jobId: z.string(),
					enabled: z.boolean(),
					recordedCommit: nullableString,
				}),
			),
		}),
	),
	page: z.object({
		total: z.number(),
		offset: z.number(),
		limit: z.number(),
		returned: z.number(),
		nextCursor: nullableString,
		stateFingerprint: z.string(),
	}),
})

export const adminPackageArtifactEvidenceCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminCapabilityAccess,
		name: 'adminPackageArtifactEvidence',
		contextRuns: 'deny',
		description:
			"Read-only evidence of which stored bundle bytes runtime serves for any owner's package. For every target declared by the serving-commit manifest (callable and importable module per export, subscriptions, app, app client, jobs), plus any extra identity rows or jobs, reports the KV key the runtime reader selects, whether the payload exists, its embedded commit, identity validation (missing, malformed, mismatched), and SHA-256 module hashes, next to the newest-build identity row and that row's own payload hashes. Paginated (page.nextCursor); targets are never silently dropped. Never executes, compiles, or rebuilds package code and never returns source, module bytes, logs, tokens, or secrets. Admin-only and audit-logged.",
		keywords: [
			'admin',
			'package artifact evidence',
			'which bytes are served',
			'serving kv key',
			'module hash',
			'bundle hash',
			'identity row',
			'newest build',
			'published bundle artifact',
			'stale artifact',
			'serving commit',
		],
		inputSchema,
		outputSchema,
		async handler(args, ctx) {
			const target = args.packageId
				? { packageId: args.packageId }
				: { packageName: args.packageName ?? '' }
			const targetReason = target.packageId
				? `package_id=${target.packageId}`
				: `package_name=${target.packageName}`
			return auditAdminCapabilityInvocation(
				ctx,
				'adminPackageArtifactEvidence',
				async () => {
					const result = await loadPackageArtifactEvidence({
						env: ctx.env,
						target,
						limit: args.limit,
						cursor: args.cursor ?? null,
					}).catch((error: unknown) => {
						if (error instanceof PackageArtifactEvidenceCursorError) {
							throw new McpCallerError(
								`${targetReason} ${error.message}: restart without a cursor.`,
							)
						}
						throw new Error(`${targetReason} artifact_evidence_read_failed`, {
							cause: error,
						})
					})
					if (!result) {
						throw new McpCallerError(`Package not found (${targetReason}).`)
					}
					return result
				},
				{
					successReason: (result) =>
						[
							`package_id=${result.package.packageId}`,
							`owner_id=${result.package.ownerId}`,
							`offset=${result.page.offset}`,
							`returned=${result.page.returned}`,
							`total=${result.page.total}`,
						].join(' '),
				},
			)
		},
	},
)
