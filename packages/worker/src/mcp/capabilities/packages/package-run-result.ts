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
			'Read the full result of a finished durable packageCheck or packagePublishExternalPush run by its workflow id. `kind: "packageCheck"` carries `ok`, `package_name`, `checks`, and `notices`. `kind: "packagePublishExternalPush"` carries the publish answer in `result` (status, commits, manifest, static dependents, hints, phase timings). Results are stored only for runs that finished without erroring: an errored run has its reason in workflowRunList `last_error`, including a publish that did not publish. Results expire after one day; `available: false` means the run has not finished, errored, or its result expired.',
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
		}),
		async handler(args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			const owner = await resolvePackageOwnerContext(ctx.env, {
				user,
				request: requireMcpRequest(ctx.callerContext),
			})
			// The key embeds the owner, so another account's run id finds nothing.
			const object = await ctx.env.REPO_SESSION_BLOBS.get(
				packageRunResultKey(owner.ownerUserId, args.workflow_id),
			)
			if (!object) return { available: false, kind: null, result: null }
			const stored = (await object.json()) as Record<string, unknown>
			if (stored['kind'] === 'packagePublishExternalPush') {
				return {
					available: true,
					kind: 'packagePublishExternalPush' as const,
					result: (stored['result'] ?? {}) as Record<string, unknown>,
				}
			}
			if (stored['kind'] === 'packageCheck') {
				const { kind: _kind, ...result } = stored
				return { available: true, kind: 'packageCheck' as const, result }
			}
			throw new McpCallerError('Stored run result has an unknown kind.')
		},
	},
)
