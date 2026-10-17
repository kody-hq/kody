import { z } from 'zod'
import {
	agentHasApprovedPick,
	proposingAgentFor,
} from '#worker/credentials/agent-credential-proposals.ts'
import {
	approveCredentialProposal,
	resolveCredentialApproval,
} from '#worker/credentials/credential-approval.ts'
import { credentialPickSchema } from '#universal/credential-pick-schema.ts'
import { loadPackageMappingScopeForRequest } from '#worker/credentials/package-mapping-scope-access.ts'
import {
	packageIdLookupDescription,
	packageNameLookupDescription,
} from '#worker/package-registry/package-name.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpRequest } from '#mcp/capabilities/meta/require-user.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import { resolveCallerSecretAuthority } from '#mcp/secrets/secret-authority.ts'
import {
	credentialKinds,
	credentialScopes,
	credentialTriggerKinds,
	describeCredentialMappingTarget,
	type ParsedCredentialProposal,
} from '#universal/credential-contracts.ts'

const refSchema = z.object({
	id: z.string(),
	name: z.string(),
	scope: z.enum(credentialScopes),
	kind: z.enum(credentialKinds),
})

const notApprovedMessage =
	'You can set this pick only to a value you proposed with credentialMappingPropose and the person approved from your link. Propose it and send them the approval URL instead.'

export const credentialTriggerPickSetCapability = defineDomainCapability(
	capabilityDomainNames.secrets,
	{
		name: 'credentialTriggerPickSet',
		orgPermission: 'none',
		description:
			"Set which credentials one need uses for your instance of a trigger (cron job, subscription, or webhook), but only to a value you already proposed with credentialMappingPropose and the person approved from that link, for example to switch back after the pick changed. The pick is resolved and written the same way Approve writes it. Anything else is refused: propose it instead. Never turns a trigger on; a trigger that is off needs approval. Needs package:execute on the package and an agent credential (MCP OAuth client, CLI, or API token); the person's own approval page and Credentials tab do not use this.",
		keywords: [
			'credential',
			'credentials',
			'mapping',
			'trigger',
			'pick',
			'webhook',
			'cron',
			'subscription',
		],
		readOnly: false,
		idempotent: true,
		destructive: false,
		inputSchema: z
			.object({
				packageId: z
					.string()
					.min(1)
					.optional()
					.describe(packageIdLookupDescription),
				kodyId: z
					.string()
					.min(1)
					.optional()
					.describe(packageNameLookupDescription),
				trigger: z.object({
					kind: z.enum(credentialTriggerKinds),
					name: z
						.string()
						.min(1)
						.describe('Job name, subscription topic, or webhook name.'),
				}),
				needKey: z.string().min(1).describe('The credential need key.'),
				credentials: z
					.union([credentialPickSchema, z.array(credentialPickSchema)])
					.describe(
						'The pick to set, as you proposed it: a credential by { name } (optionally with scope) or { id }, or an array of them. [] is "none on purpose".',
					),
			})
			.refine((input) => Boolean(input.packageId ?? input.kodyId), {
				message: 'Provide packageId or kodyId.',
				path: ['packageId'],
			}),
		outputSchema: z.object({
			trigger: z.object({
				kind: z.enum(credentialTriggerKinds),
				name: z.string(),
			}),
			needKey: z.string(),
			credentials: z.array(refSchema),
			message: z.string(),
		}),
		async handler(args, ctx: CapabilityContext) {
			const request = requireMcpRequest(ctx.callerContext)
			const { authorityPackageId } = resolveCallerSecretAuthority({
				storageContext: ctx.callerContext.storageContext,
			})
			if (authorityPackageId) {
				throw new McpCallerError(
					'Package code cannot set credential picks. Ask the person to map credentials on the package page.',
				)
			}
			const agent = proposingAgentFor(request)
			if (!agent) {
				throw new McpCallerError(
					'Setting a trigger pick needs a signed-in person calling through an MCP client, the CLI, or an API token. Use credentialMappingPropose instead.',
				)
			}
			const scope = await loadPackageMappingScopeForRequest({
				env: ctx.env,
				baseUrl: ctx.callerContext.baseUrl,
				request,
				packageIdOrKodyId: args.packageId ?? args.kodyId ?? '',
			})
			if (!scope) {
				throw new McpCallerError(
					'Package not found in this org, or you lack package:execute on it.',
				)
			}
			const target = { type: 'trigger' as const, trigger: args.trigger }
			const proposal: ParsedCredentialProposal = {
				changes: [
					{
						target,
						needKey: args.needKey,
						credentials: Array.isArray(args.credentials)
							? args.credentials
							: [args.credentials],
					},
				],
				enable: [],
				sender: null,
				reason: null,
				errors: [],
			}
			const { view, resolved } = await resolveCredentialApproval(
				scope,
				proposal,
			)
			const [change] = resolved
			if (!change || change.error) {
				throw new McpCallerError(
					change?.error?.message ?? 'This pick cannot be set.',
				)
			}
			if (change.willEnable) {
				throw new McpCallerError(
					`Your ${describeCredentialMappingTarget(target)} is off. Turning it on needs approval: propose the mapping with credentialMappingPropose.`,
				)
			}
			const approved = await agentHasApprovedPick({
				db: ctx.env.APP_DB,
				orgId: request.org.id,
				packageId: scope.savedPackage.id,
				agent,
				pick: {
					trigger: args.trigger,
					instanceId: change.trigger?.instanceId ?? null,
					needKey: args.needKey,
					credentialIds: change.credentialIds ?? [],
				},
			})
			if (!approved) throw new McpCallerError(notApprovedMessage)
			const outcome = await approveCredentialProposal({
				scope,
				proposal,
				fingerprint: view.fingerprint,
			})
			switch (outcome.status) {
				case 'approved':
					return {
						trigger: args.trigger,
						needKey: args.needKey,
						credentials: change.after,
						message: `Set ${args.needKey} for your ${describeCredentialMappingTarget(target)}.`,
					}
				case 'invalid':
				case 'stale':
					throw new McpCallerError(
						'Credentials or mappings changed while setting this pick. Try again.',
					)
				case 'conflict':
					throw new McpCallerError(outcome.message)
				default: {
					const exhaustive: never = outcome
					throw new Error(`Unhandled approval outcome: ${String(exhaustive)}`)
				}
			}
		},
	},
)
