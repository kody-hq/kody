import { z } from 'zod'
import { McpCallerError } from '#mcp/caller-error.ts'
import { authorizePackageWrite } from '#worker/authorization/authorize.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	requireMcpRequest,
	requireMcpUser,
} from '#mcp/capabilities/meta/require-user.ts'
import {
	packageIdLookupDescription,
	packageKodyIdOptionalInput,
	packageNameLookupDescription,
} from '#worker/package-registry/package-name.ts'
import { resolvePackageOwnerContext } from '#worker/package-registry/package-owner.ts'
import { dispatchContextPublishBuild } from '#worker/publish-offload/context-dispatch.ts'
import { isPublishOffloadEnabledFor } from '#worker/publish-offload/flag.ts'
import {
	publishLargePackagesDocsUrl,
	publishOffloadLimits,
} from '#worker/publish-offload/policy.ts'
import {
	createPublishBuild,
	purgeExpiredPublishBuilds,
} from '#worker/publish-offload/store.ts'
import { publishBuilderVersion } from '#worker/publish-offload/types.ts'
import { resolveArtifactSourceHead } from '#worker/repo/artifacts.ts'
import { resolveOwnedPackageSource } from './resolve-package-source.ts'

const inputSchema = z.object({
	package_id: z.string().min(1).optional().describe(packageIdLookupDescription),
	name: z.string().min(1).optional().describe(packageNameLookupDescription),
	kody_id: packageKodyIdOptionalInput(),
	origin: z
		.enum(['cli', 'context'])
		.describe(
			'`cli`: return an upload ticket so this machine builds and uploads. `context`: build on an execution context you operate; the call waits for the context to build and seal the upload.',
		),
	context: z
		.string()
		.min(1)
		.optional()
		.describe(
			'Execution context name or id for `origin: context`. Defaults to the first online context you operate.',
		),
	expected_commit: z
		.string()
		.regex(/^[0-9a-f]{40}$/)
		.optional()
		.describe(
			'The commit the caller is about to build (the CLI sends its pushed HEAD). Refused unless it is the commit Kody sees at the head of the package repo.',
		),
})

const outputSchema = z.toJSONSchema(
	z.object({
		build_id: z.string(),
		package_id: z.string(),
		commit: z.string(),
		origin: z.enum(['cli', 'context']),
		status: z.enum(['uploading', 'sealed']),
		upload_ticket: z
			.string()
			.optional()
			.describe(
				'`cli` only. Bearer token for this one build; it cannot publish.',
			),
		upload_path: z
			.string()
			.describe(
				'Upload API path; join it with the Open API host the caller uses.',
			),
		source_root: z
			.string()
			.describe(
				'Package source root in the repo; the builder applies its `.kodyignore`.',
			),
		manifest_path: z
			.string()
			.describe('Repo path of the package.json the builder reads.'),
		expires_at: z.string(),
		builder_version: z.number(),
		chunk_bytes: z.number(),
		max_source_bytes: z.number(),
		max_target_bytes: z.number(),
		context_name: z.string().nullable().optional(),
		docs_url: z.string(),
	}),
) as Record<string, unknown>

export const publishBuildCreateCapability = defineDomainCapability(
	capabilityDomainNames.packages,
	{
		name: 'packagePublishBuildCreate',
		contextRuns: 'deny',
		orgPermission: 'package:write',
		description: `Publish offload (publish-offload feature flag; off by default). Start a build of the package's pushed Artifacts HEAD outside Kody cloud, for packages too large to bundle inside a Worker. \`origin: cli\` returns a per-build upload ticket so the Kody CLI builds on this machine and uploads content-addressed chunks; \`origin: context\` runs the build on an execution context you operate. Then publish with \`packagePublishExternalPush({ publish_build_id })\`: the server re-runs the cheap checks, verifies the uploaded tree and every bundle, rebuilds a sample itself, and only then serves the commit. Use \`kody package publish --build local|context\` instead of calling this by hand. Docs: ${publishLargePackagesDocsUrl}`,
		keywords: [
			'package',
			'publish',
			'build',
			'offload',
			'large',
			'local',
			'context',
		],
		readOnly: false,
		idempotent: false,
		destructive: false,
		inputSchema,
		outputSchema,
		async handler(args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			const request = requireMcpRequest(ctx.callerContext)
			if (
				!(await isPublishOffloadEnabledFor(
					ctx.env.APP_DB,
					user.userId,
					request.org.id,
				))
			) {
				throw new McpCallerError(
					'Publishing a build made outside Kody cloud needs the publish-offload feature flag, which is off for this account.',
				)
			}
			const owner = await resolvePackageOwnerContext(ctx.env, {
				user,
				request,
			})
			const nameInput = args.name?.trim() || undefined
			const { packageId, userId, name, source } =
				await resolveOwnedPackageSource({
					db: ctx.env.APP_DB,
					userId: owner.ownerUserId,
					ownerScope: owner.ownerScope,
					args: {
						package_id: args.package_id,
						kody_id: nameInput ?? args.kody_id?.trim() ?? undefined,
					},
				})
			await authorizePackageWrite(
				{ env: ctx.env, request },
				{ id: packageId, userId, label: name },
			)
			const head = await resolveArtifactSourceHead(ctx.env, source.repo_id)
			if (!head.commit) {
				throw new McpCallerError(
					`Package "${name}" has no pushed commit to build. Push first.`,
				)
			}
			if (args.expected_commit && args.expected_commit !== head.commit) {
				throw new McpCallerError(
					`Kody sees ${head.commit.slice(0, 12)} at the head of "${name}" (branch ${head.branch}), not your commit ${args.expected_commit.slice(0, 12)}. Nothing was built. Push that commit to the package's Kody remote and try again.`,
				)
			}
			await purgeExpiredPublishBuilds({
				db: ctx.env.APP_DB,
				bucket: ctx.env.REPO_SESSION_BLOBS,
			}).catch(() => {})
			const created = await createPublishBuild({
				db: ctx.env.APP_DB,
				packageId,
				sourceId: source.id,
				ownerUserId: userId,
				requesterUserId: user.userId,
				orgId: request.org.id,
				commit: head.commit,
				origin: args.origin,
			})
			const common = {
				build_id: created.buildId,
				package_id: packageId,
				commit: head.commit,
				origin: args.origin,
				upload_path: `/v1/publish-builds/${created.buildId}`,
				source_root: source.source_root,
				manifest_path: source.manifest_path,
				expires_at: created.expiresAt,
				builder_version: publishBuilderVersion,
				chunk_bytes: publishOffloadLimits.chunkBytes,
				max_source_bytes: publishOffloadLimits.maxSourceBytes,
				max_target_bytes: publishOffloadLimits.maxTargetBytes,
				docs_url: publishLargePackagesDocsUrl,
			}
			if (args.origin === 'cli') {
				return {
					...common,
					status: 'uploading' as const,
					upload_ticket: created.ticket,
				}
			}
			const dispatched = await dispatchContextPublishBuild({
				env: ctx.env,
				callerContext: ctx.callerContext,
				request,
				buildId: created.buildId,
				ticket: created.ticket,
				uploadPath: common.upload_path,
				packageId,
				packageName: name,
				repoId: source.repo_id,
				commit: head.commit,
				sourceRoot: source.source_root,
				manifestPath: source.manifest_path,
				context: args.context ?? null,
			})
			return {
				...common,
				status: 'sealed' as const,
				context_name: dispatched.contextName,
			}
		},
	},
)
