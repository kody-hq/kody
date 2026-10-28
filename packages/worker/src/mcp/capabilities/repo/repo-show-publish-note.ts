import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	requireMcpRequest,
	requireMcpUser,
} from '#mcp/capabilities/meta/require-user.ts'
import { resolveOwnedPackageSource } from '#mcp/capabilities/packages/resolve-package-source.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import { authorize, packageResource } from '#worker/authorization/authorize.ts'
import { resolvePackageOwnerContext } from '#worker/package-registry/package-owner.ts'
import {
	packageIdLookupDescription,
	packageKodyIdOptionalInput,
} from '#worker/package-registry/package-name.ts'
import { getEntitySourceByIdForUser } from '#worker/repo/entity-sources.ts'
import {
	kodyPublishGitNoteSchema,
	readPublishGitNoteFromArtifactsRepo,
} from '#worker/repo/publish-git-notes.ts'

const inputSchema = z
	.object({
		source_id: z
			.string()
			.min(1)
			.optional()
			.describe('Shared entity source id for any repo-backed entity.'),
		package_id: z
			.string()
			.min(1)
			.optional()
			.describe(packageIdLookupDescription),
		kody_id: packageKodyIdOptionalInput(),
		commit: z
			.string()
			.min(1)
			.optional()
			.describe(
				'Commit oid to inspect. Defaults to the source published_commit.',
			),
	})
	.superRefine((value, ctx) => {
		const count =
			(value.source_id !== undefined ? 1 : 0) +
			(value.package_id !== undefined ? 1 : 0) +
			(value.kody_id !== undefined ? 1 : 0)
		if (count !== 1) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['source_id'],
				message:
					'Provide exactly one of `source_id`, `package_id`, or leftover `kody_id`. Prefer `package_id` or `source_id`.',
			})
		}
	})

const outputSchema = z.object({
	found: z.boolean(),
	commit: z.string(),
	source_id: z.string(),
	repo_id: z.string(),
	raw_note: z.string().nullable(),
	note: kodyPublishGitNoteSchema.nullable(),
})

export const repoShowPublishNoteCapability = defineDomainCapability(
	capabilityDomainNames.repo,
	{
		name: 'repoShowPublishNote',
		contextRuns: 'allow',
		orgPermission: 'package:read',
		description:
			'Read the Kody publish harness git note attached to a published Artifacts commit. Use this to inspect publish provenance, session/conversation ids, and check summaries without opening D1.',
		keywords: [
			'repo',
			'git',
			'notes',
			'publish',
			'audit',
			'provenance',
			'artifacts',
		],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema,
		outputSchema,
		async handler(args, ctx) {
			const owner = await resolvePackageOwnerContext(ctx.env, {
				user: requireMcpUser(ctx.callerContext),
				request: requireMcpRequest(ctx.callerContext),
			})
			const source =
				args.source_id !== undefined
					? await getEntitySourceByIdForUser(ctx.env.APP_DB, {
							id: args.source_id,
							userId: owner.ownerUserId,
						})
					: (
							await resolveOwnedPackageSource({
								db: ctx.env.APP_DB,
								userId: owner.ownerUserId,
								ownerScope: owner.ownerScope,
								args: {
									package_id: args.package_id,
									kody_id: args.kody_id,
								},
							})
						).source
			if (!source) {
				throw new McpCallerError('Repo source was not found for this user.')
			}
			if (source.entity_kind === 'package') {
				await authorize(
					{ env: ctx.env, request: ctx.callerContext.request },
					'package:read',
					packageResource({ id: source.entity_id, userId: source.user_id }),
				)
			}
			const commit = args.commit ?? source.published_commit
			if (!commit) {
				throw new McpCallerError(
					`Source "${source.id}" has no published commit yet. Pass an explicit \`commit\` or publish source first.`,
				)
			}
			const result = await readPublishGitNoteFromArtifactsRepo({
				env: ctx.env,
				repoId: source.repo_id,
				commitOid: commit,
			})
			return {
				found: result.found,
				commit: result.commit,
				source_id: source.id,
				repo_id: source.repo_id,
				raw_note: result.rawNote,
				note: result.note,
			}
		},
	},
)
