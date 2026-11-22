import { z } from 'zod'
import type { McpCallerContext } from '@kody-internal/shared/chat.ts'
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
import {
	type ContextDispatchFailure,
	dispatchContextPublishBuild,
	mapContextDispatchFailure,
} from '#worker/publish-offload/context-dispatch.ts'
import { ExecutionContextError } from '#worker/execution-contexts/errors.ts'
import { isExecutionContextsEnabledFor } from '#worker/execution-contexts/flag.ts'
import {
	assertNever,
	catchDeadline,
	reportHandledError,
} from '#worker/outbound/typed-failure.ts'
import {
	outboundTimeoutMs,
	withDeadline,
} from '#worker/outbound/with-deadline.ts'
import { isPublishOffloadEnabledFor } from '#worker/publish-offload/flag.ts'
import { publishContextFlagsOffMessage } from '#worker/publish-offload/publish-routing.ts'
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

/** Why `packagePublishBuildCreate` refuses; mapped once by the handler. */
export type PublishBuildCreateFailure =
	| { kind: 'offload_flag_off' }
	| { kind: 'context_flags_off' }
	| { kind: 'no_pushed_commit'; packageName: string }
	| {
			kind: 'head_mismatch'
			packageName: string
			headCommit: string
			branch: string
			expectedCommit: string
	  }
	| { kind: 'no_context_took_build' }
	| ContextDispatchFailure

export function mapPublishBuildCreateFailure(
	failure: PublishBuildCreateFailure,
): McpCallerError {
	switch (failure.kind) {
		case 'offload_flag_off':
			return new McpCallerError(
				'Publishing a build made outside Kody cloud needs the publish-offload feature flag, which is off for this account.',
			)
		case 'context_flags_off':
			return new ExecutionContextError({
				status: 403,
				code: 'feature_disabled',
				message: publishContextFlagsOffMessage,
			})
		case 'no_pushed_commit':
			return new McpCallerError(
				`Package "${failure.packageName}" has no pushed commit to build. Push first.`,
			)
		case 'head_mismatch':
			return new McpCallerError(
				`Kody sees ${failure.headCommit.slice(0, 12)} at the head of "${failure.packageName}" (branch ${failure.branch}), not your commit ${failure.expectedCommit.slice(0, 12)}. Nothing was built. Push that commit to the package's Kody remote and try again.`,
			)
		case 'no_context_took_build':
			return new McpCallerError(
				'No execution context you operate took this publish build.',
			)
		case 'no_git_repo':
		case 'context_run_failed':
		case 'not_sealed':
		case 'needs_person':
		case 'context_run_caller':
		case 'no_context_available':
		case 'context_timed_out':
		case 'deadline_exceeded':
			return mapContextDispatchFailure(failure)
		default:
			return assertNever(failure, 'publish build create failure')
	}
}

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
		walletGuard: 'publish',
		contextRuns: 'deny',
		orgPermission: 'package:write',
		description: `Publish offload (publish-offload feature flag; off by default). Start a build of the package's pushed Artifacts HEAD outside Kody cloud, for packages too large to bundle inside a Worker. \`origin: cli\` returns a per-build upload ticket so the Kody CLI builds on this machine and uploads content-addressed chunks; \`origin: context\` runs the build on an execution context you operate. Then publish with \`packagePublishExternalPush({ publish_build_id })\`: the server re-runs the cheap checks, verifies the uploaded tree and every bundle against the pushed commit, and only then serves the commit. The upload is the published artifact: Kody does not build it again, so Kody cloud build limits do not apply to it. Use \`kody package publish --build local|context\` instead of calling this by hand. Docs: ${publishLargePackagesDocsUrl}`,
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
			const result = await catchDeadline(() => createBuild(args, ctx))
			if ('kind' in result) throw mapPublishBuildCreateFailure(result)
			return result
		},
	},
)

/** Names a failure as the union, so success objects never gain `kind`. */
const failed = (failure: PublishBuildCreateFailure) => failure

async function createBuild(
	args: z.infer<typeof inputSchema>,
	ctx: { env: Env; callerContext: McpCallerContext },
) {
	const user = requireMcpUser(ctx.callerContext)
	const request = requireMcpRequest(ctx.callerContext)
	if (
		!(await isPublishOffloadEnabledFor(
			ctx.env.APP_DB,
			user.userId,
			request.org.id,
		))
	) {
		return failed({ kind: 'offload_flag_off' })
	}
	if (
		args.origin === 'context' &&
		!(await withDeadline(
			{
				label: 'feature_flags.execution_contexts',
				timeoutMs: outboundTimeoutMs.d1,
			},
			() =>
				isExecutionContextsEnabledFor(
					ctx.env.APP_DB,
					user.userId,
					request.org.id,
				),
		))
	) {
		return failed({ kind: 'context_flags_off' })
	}
	const owner = await withDeadline(
		{ label: 'package_owner.resolve', timeoutMs: outboundTimeoutMs.d1 },
		() => resolvePackageOwnerContext(ctx.env, { user, request }),
	)
	const nameInput = args.name?.trim() || undefined
	const { packageId, userId, name, source } = await withDeadline(
		{ label: 'package_source.resolve', timeoutMs: outboundTimeoutMs.d1 },
		() =>
			resolveOwnedPackageSource({
				db: ctx.env.APP_DB,
				userId: owner.ownerUserId,
				ownerScope: owner.ownerScope,
				args: {
					package_id: args.package_id,
					kody_id: nameInput ?? args.kody_id?.trim() ?? undefined,
				},
			}),
	)
	await withDeadline(
		{ label: 'package_write.authorize', timeoutMs: outboundTimeoutMs.d1 },
		() =>
			authorizePackageWrite(
				{ env: ctx.env, request },
				{ id: packageId, userId, label: name },
			),
	)
	const head = await withDeadline(
		{
			label: 'artifacts.source_head',
			timeoutMs: outboundTimeoutMs.durableObject,
		},
		() => resolveArtifactSourceHead(ctx.env, source.repo_id),
	)
	if (!head.commit) {
		return failed({ kind: 'no_pushed_commit', packageName: name })
	}
	if (args.expected_commit && args.expected_commit !== head.commit) {
		return failed({
			kind: 'head_mismatch',
			packageName: name,
			headCommit: head.commit,
			branch: head.branch,
			expectedCommit: args.expected_commit,
		})
	}
	try {
		await purgeExpiredPublishBuilds({
			db: ctx.env.APP_DB,
			bucket: ctx.env.REPO_SESSION_BLOBS,
		})
	} catch (error) {
		// Opportunistic: a failed purge never blocks a new build.
		reportHandledError('publish_builds.purge_expired', error)
	}
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
	if (dispatched.kind === 'cloud') {
		return failed({ kind: 'no_context_took_build' })
	}
	if (dispatched.kind !== 'context') return dispatched
	return {
		...common,
		status: 'sealed' as const,
		context_name: dispatched.contextName,
	}
}
