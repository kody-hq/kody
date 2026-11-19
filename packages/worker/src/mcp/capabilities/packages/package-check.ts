import { z } from 'zod'
import { McpCallerError } from '#mcp/caller-error.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { dispatchDurableRun } from '#mcp/capabilities/durable-escalation.ts'
import {
	requireMcpRequest,
	requireMcpUser,
} from '#mcp/capabilities/meta/require-user.ts'
import { UpgradeRequiredError } from '#mcp/upgrade-required-error.ts'
import { maxPackageCheckUploadBytes } from '#worker/open-api/api-body-limits.ts'
import {
	durablePackageCheckWorkflowCode,
	packageCheckWorkflowName,
} from '#worker/package-runtime/package-check-run.constants.ts'
import {
	packageOwnerEntitlementEmail,
	resolvePackageOwnerContext,
} from '#worker/package-registry/package-owner.ts'
import {
	createPackageCheckUploadId,
	isPackageCheckUploadId,
	packageCheckUploadKey,
} from '#worker/repo/package-check-upload.ts'
import { requestLineage } from '#worker/request-context/request-context.ts'
import { getErrorMessage } from '@kody-internal/shared/error-message.ts'

export { packageCheckMaxFiles } from '#worker/repo/package-check-upload.ts'

/** First `@kodycodes/cli` release that uploads the tree and polls the run. */
export const minimumPackageCheckCliVersion = '3.46.0'

export const packageCheckUpgradeRequiredMessage = `packageCheck no longer takes the package tree in the request and no longer answers synchronously. Upgrade @kodycodes/cli to ${minimumPackageCheckCliVersion} or newer (\`npm install -g @kodycodes/cli@latest\`), or upload the tree with POST /v1/packages/check-uploads and call packageCheck({ upload_id }).`

export const packageCheckUploadCreateCapability = defineDomainCapability(
	capabilityDomainNames.packages,
	{
		name: 'packageCheckUploadCreate',
		contextRuns: 'allow',
		orgPermission: 'package:read',
		description: `Reserve an upload for packageCheck. Over the HTTP API this is \`POST /v1/packages/check-uploads\`: send the tree as the request body, a JSON object \`{ "files": { path: utf8 }, "binary_contents": { path: base64 } }\` with paths relative to the package root, with a Content-Length of at most ${maxPackageCheckUploadBytes} bytes. The API streams the body into short-lived staging without parsing it and answers \`{ upload_id }\`. Then call packageCheck({ upload_id }). An upload is deleted when its check finishes and expires after one day otherwise. Calling this capability outside the HTTP API reserves an id but uploads nothing.`,
		keywords: ['package', 'check', 'upload', 'publish', 'dry run'],
		readOnly: false,
		idempotent: false,
		destructive: false,
		inputSchema: z.object({}),
		outputSchema: z.object({
			upload_id: z.string().describe('Pass to packageCheck({ upload_id }).'),
			object_key: z
				.string()
				.describe('Staging key the API edge writes the request body to.'),
			max_bytes: z.number().describe('Largest accepted upload, in bytes.'),
		}),
		async handler(_args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			const owner = await resolvePackageOwnerContext(ctx.env, {
				user,
				request: requireMcpRequest(ctx.callerContext),
			})
			const uploadId = createPackageCheckUploadId()
			return {
				upload_id: uploadId,
				object_key: packageCheckUploadKey(owner.ownerUserId, uploadId),
				max_bytes: maxPackageCheckUploadBytes,
			}
		},
	},
)

export const packageCheckCapability = defineDomainCapability(
	capabilityDomainNames.packages,
	{
		name: 'packageCheck',
		walletGuard: 'check',
		contextRuns: 'allow',
		orgPermission: 'package:read',
		description:
			'Dry-run a git-push publish on an uploaded package tree without saving, pushing, or publishing anything. Upload the tree first (`POST /v1/packages/check-uploads`, see packageCheckUploadCreate), then pass its `upload_id`. The check always runs as a durable workflow, never in the calling request: this returns `{ status: "dispatched", workflow_id }` right away. Poll packageRunResult({ workflow_id }) until its `status` is terminal (its `progress` shows the current phase and artifact chunk counts); the same answer then carries the result. Cancel with workflowRunCancel. The tree goes through what a git-push publish does after its clone, in the same throwaway isolates: `.kodyignore`, the checked-out tree cap, the same checks with the same options (manifest, credential stamp gate, docs, skills, dependencies, typecheck, lint), then every published artifact built the way the publish rebuild builds it (same targets, per-isolate batches, and waves), saving nothing. Not run: cloning the pushed commit from Artifacts. In the result, `ok: false` means publish would refuse this tree with the same messages in `checks`. A run that ends errored hit a Kody infrastructure failure, not a package problem. Calling again with the same upload while its run is active returns that run. `kody dev check` calls this.',
		keywords: [
			'package',
			'check',
			'publish',
			'dry run',
			'validate',
			'lint',
			'typecheck',
			'credentials',
			'stamp',
		],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({
			upload_id: z
				.string()
				.optional()
				.describe(
					'Id returned by `POST /v1/packages/check-uploads` for the uploaded tree. Required.',
				),
			files: z
				.unknown()
				.optional()
				.describe(
					'Removed. Sending the tree inline is refused with `upgrade_required`; upload it and pass `upload_id`.',
				),
		}),
		outputSchema: z.object({
			status: z.literal('dispatched'),
			workflow_id: z
				.string()
				.describe('Poll with packageRunResult({ workflow_id }).'),
			workflow_name: z.string(),
			idempotency_key: z.string(),
			run_status: z.string().nullable(),
			message: z.string(),
		}),
		async handler(args, ctx) {
			if (args.files !== undefined || !args.upload_id) {
				throw new UpgradeRequiredError({
					message: packageCheckUpgradeRequiredMessage,
					minimumCliVersion: minimumPackageCheckCliVersion,
				})
			}
			if (!isPackageCheckUploadId(args.upload_id)) {
				throw new McpCallerError('upload_id is not valid.')
			}
			const user = requireMcpUser(ctx.callerContext)
			const request = requireMcpRequest(ctx.callerContext)
			const owner = await resolvePackageOwnerContext(ctx.env, {
				user,
				request,
			})
			// The key embeds the owner, so only the uploading account finds it.
			const upload = await ctx.env.REPO_SESSION_BLOBS.head(
				packageCheckUploadKey(owner.ownerUserId, args.upload_id),
			)
			if (!upload) {
				throw new McpCallerError(
					'No uploaded tree for this upload_id. Uploads are deleted when their check finishes and expire after a day; upload the tree again.',
				)
			}
			const outcome = await dispatchDurableRun({
				env: ctx.env,
				userId: owner.ownerUserId,
				userEmail: packageOwnerEntitlementEmail(owner),
				lineage: requestLineage(request),
				// Caller plus content hash. The upload id is part of the key
				// because the run reads and then deletes that one staged object.
				idempotencyParts: [
					packageCheckWorkflowName,
					'v1',
					upload.etag,
					args.upload_id,
				],
				workflowName: packageCheckWorkflowName,
				// A finished check is never replayed: its answer depends on the
				// published package and credentials at the time it ran.
				rerunComplete: true,
				durableCode: durablePackageCheckWorkflowCode,
				durableParams: {
					upload_id: args.upload_id,
					owner_scope: owner.ownerScope,
					owner_email: packageOwnerEntitlementEmail(owner) ?? null,
					base_url: ctx.callerContext.baseUrl,
				},
			})
			if (outcome.kind === 'failed') {
				// Preserve typed errors (EntitlementLimitError, ...) for toApiError.
				if (outcome.error instanceof Error) throw outcome.error
				throw new Error(getErrorMessage(outcome.error))
			}
			return outcome.handle
		},
	},
)
