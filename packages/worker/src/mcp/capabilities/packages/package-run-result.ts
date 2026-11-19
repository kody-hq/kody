import { z } from 'zod'
import { McpCallerError } from '#mcp/caller-error.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	requireMcpRequest,
	requireMcpUser,
} from '#mcp/capabilities/meta/require-user.ts'
import { resolvePackageOwnerContext } from '#worker/package-registry/package-owner.ts'
import { packageRunResultKey } from '#worker/repo/package-check-upload.ts'

export const packageRunResultCapability = defineDomainCapability(
	capabilityDomainNames.packages,
	{
		name: 'packageRunResult',
		contextRuns: 'allow',
		orgPermission: 'package:read',
		description:
			'Follow a durable packageCheck or packagePublishExternalPush run by its workflow id, and read its full result once it finishes. Poll until `status` is terminal (`complete`, `errored`, `terminated`, `cancelled`) or `available` is true; `progress` is the current phase, a one-line message, and done/total when the phase is chunked (artifact builds). `kind: "packageCheck"` carries `ok`, `package_name`, `checks`, and `notices` in `result`. `kind: "packagePublishExternalPush"` carries the publish answer in `result` (status, commits, manifest, static dependents, hints, phase timings), including a refusal, whose run ends `errored`. A run Kody itself failed stores no result: its reason is `last_error`. Results expire after one day. `status: null` means no check or publish run with this id exists for the account; other workflow runs are read with workflowRunList.',
		keywords: ['package', 'check', 'publish', 'result', 'workflow', 'run'],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({
			workflow_id: z
				.string()
				.min(1)
				.describe('`workflow_id` from the dispatched packageCheck or publish.'),
		}),
		outputSchema: z.object({
			available: z.boolean(),
			kind: z
				.enum(['packageCheck', 'packagePublishExternalPush'])
				.nullable()
				.describe('Which operation the run executed; null when unavailable.'),
			result: z
				.record(z.string(), z.unknown())
				.nullable()
				.describe('The stored result; null when unavailable.'),
			status: z
				.string()
				.nullable()
				.describe(
					'Workflow status of the run, such as queued, running, complete, or errored. Null when the account has no check or publish run with this id.',
				),
			progress: z
				.object({
					phase: z.string(),
					message: z.string(),
					done: z.number().optional(),
					total: z.number().optional(),
				})
				.nullable()
				.describe('Where a running run is; null before its first report.'),
			last_error: z
				.string()
				.nullable()
				.describe('Why the run errored; null otherwise.'),
		}),
		async handler(args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			const owner = await resolvePackageOwnerContext(ctx.env, {
				user,
				request: requireMcpRequest(ctx.callerContext),
			})
			const { getPackageRunForUser } =
				await import('#worker/package-runtime/package-workflows.ts')
			// package:read follows package runs only: any other workflow run
			// stays behind job:read (workflowRunList).
			const run = await getPackageRunForUser({
				env: ctx.env,
				userId: owner.ownerUserId,
				id: args.workflow_id,
			})
			const state = {
				status: run?.status ?? null,
				progress: run?.progress ?? null,
				last_error: run?.lastError ?? null,
			}
			// Read after the status: a run seen terminal has already stored its
			// result. The key embeds the owner, so another account's run id finds
			// nothing.
			const object = await ctx.env.REPO_SESSION_BLOBS.get(
				packageRunResultKey(owner.ownerUserId, args.workflow_id),
			)
			if (!object) {
				return { available: false, kind: null, result: null, ...state }
			}
			const stored = (await object.json()) as Record<string, unknown>
			if (stored['kind'] === 'packagePublishExternalPush') {
				return {
					available: true,
					kind: 'packagePublishExternalPush' as const,
					result: (stored['result'] ?? {}) as Record<string, unknown>,
					...state,
				}
			}
			if (stored['kind'] === 'packageCheck') {
				const { kind: _kind, ...result } = stored
				return {
					available: true,
					kind: 'packageCheck' as const,
					result,
					...state,
				}
			}
			throw new McpCallerError('Stored run result has an unknown kind.')
		},
	},
)
