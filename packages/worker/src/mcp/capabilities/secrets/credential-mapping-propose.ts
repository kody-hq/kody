import { z } from 'zod'
import {
	proposingAgentFor,
	recordCredentialProposal,
} from '#worker/credentials/agent-credential-proposals.ts'
import { resolveCredentialApproval } from '#worker/credentials/credential-approval.ts'
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
	buildCredentialApprovalHref,
	credentialApprovalErrorCodes,
	credentialKinds,
	credentialMappingLayers,
	credentialProposalSenderKinds,
	credentialScopes,
	credentialTriggerKinds,
	parseCredentialApprovalQuery,
	type CredentialMappingProposalChange,
	type CredentialPick,
	type CredentialProposalSender,
} from '#universal/credential-contracts.ts'
import {
	canonicalizeEnablementSender,
	isCompleteEnablementSender,
} from '#worker/enablements/sender-match.ts'

const picksSchema = z
	.union([credentialPickSchema, z.array(credentialPickSchema)])
	.describe(
		'A credential by { name } (optionally with scope "org" or "personal") or { id }, or an array of them. [] maps the need to "none on purpose".',
	)

const needPicksSchema = z.record(z.string().min(1), picksSchema)

const refSchema = z.object({
	id: z.string(),
	name: z.string(),
	scope: z.enum(credentialScopes),
	kind: z.enum(credentialKinds),
})

const triggerRefSchema = z.object({
	kind: z.enum(credentialTriggerKinds),
	name: z.string(),
})

const targetSchema = z.discriminatedUnion('type', [
	z.object({
		type: z.literal('default'),
		layer: z.enum(credentialMappingLayers),
	}),
	z.object({
		type: z.literal('trigger'),
		trigger: triggerRefSchema,
	}),
])

const viewSchema = z.object({
	ok: z.literal(true),
	package: z.object({ id: z.string(), kodyId: z.string() }),
	reason: z.string().nullable(),
	canApprove: z.boolean(),
	fingerprint: z.string(),
	changes: z.array(
		z.object({
			target: targetSchema,
			needKey: z.string(),
			need: z
				.object({
					kind: z.enum(credentialKinds).nullable(),
					provider: z.string(),
					description: z.string(),
					multiple: z.boolean(),
				})
				.nullable(),
			before: z
				.array(refSchema)
				.nullable()
				.describe('The stored override today; null means it inherits.'),
			beforeUnusableIds: z
				.array(z.string())
				.describe(
					'Stored credential ids left out of before because you can no longer use them (deleted or Use revoked).',
				),
			after: z.array(refSchema),
			willEnable: z
				.boolean()
				.describe('Approving turns this trigger on for the approver.'),
			error: z
				.object({
					code: z.enum(credentialApprovalErrorCodes),
					message: z.string(),
					createUrl: z.string().optional(),
				})
				.nullable(),
		}),
	),
	sender: z
		.object({
			kind: z.enum(credentialProposalSenderKinds),
			value: z.string().nullable(),
		})
		.nullable()
		.describe(
			'Sender stored when this proposal turns on an inbound-email subscription. Null when the link names no sender.',
		),
	enable: z.array(
		z.object({
			trigger: triggerRefSchema,
			willEnable: z
				.boolean()
				.describe('False when it is already on for the approver.'),
			error: z
				.object({
					code: z.enum(credentialApprovalErrorCodes),
					message: z.string(),
				})
				.nullable(),
		}),
	),
	errors: z.array(z.string()),
})

function proposalSender(
	sender:
		| {
				kind: (typeof credentialProposalSenderKinds)[number]
				value?: string | null
		  }
		| undefined,
): CredentialProposalSender | null {
	if (!sender) return null
	const canonical = canonicalizeEnablementSender({
		senderKind: sender.kind,
		senderValue: sender.value,
	})
	if (!isCompleteEnablementSender(canonical) || !canonical.senderKind) {
		// A provided but unusable sender must not become "no sender": with one
		// live email enablement, approval would bind that row by accident.
		throw new McpCallerError(
			`sender kind "${sender.kind}" needs a usable value (member person id, email address, or bare domain; any_authenticated needs none).`,
		)
	}
	return { kind: canonical.senderKind, value: canonical.senderValue }
}

function toPicks(value: CredentialPick | Array<CredentialPick>) {
	return Array.isArray(value) ? value : [value]
}

function proposalChanges(args: {
	defaults?: Record<string, CredentialPick | Array<CredentialPick>>
	mine?: Record<string, CredentialPick | Array<CredentialPick>>
	triggers?: Array<{
		kind: (typeof credentialTriggerKinds)[number]
		name: string
		credentials: Record<string, CredentialPick | Array<CredentialPick>>
	}>
}): Array<CredentialMappingProposalChange> {
	const changes: Array<CredentialMappingProposalChange> = []
	for (const [layer, needs] of [
		['org', args.defaults],
		['mine', args.mine],
	] as const) {
		for (const [needKey, picks] of Object.entries(needs ?? {})) {
			changes.push({
				target: { type: 'default', layer },
				needKey,
				credentials: toPicks(picks),
			})
		}
	}
	for (const trigger of args.triggers ?? []) {
		for (const [needKey, picks] of Object.entries(trigger.credentials)) {
			changes.push({
				target: {
					type: 'trigger',
					trigger: { kind: trigger.kind, name: trigger.name },
				},
				needKey,
				credentials: toPicks(picks),
			})
		}
	}
	return changes
}

export const credentialMappingProposeCapability = defineDomainCapability(
	capabilityDomainNames.secrets,
	{
		name: 'credentialMappingPropose',
		orgPermission: 'none',
		description:
			'Propose which credentials a package uses: org default mappings (defaults), your own defaults (mine), per-trigger mappings for your instance of a cron job, subscription, or webhook (triggers), and triggers to turn on with no mapping (enable). Never writes a mapping. Returns an approval URL to send to the person; nothing changes until they review it and click Approve, which applies every change at once and turns on every trigger it maps or enables. A webhook URL must be minted before it can be approved; minting alone does not turn it on. email.message.received and email.message.quarantined run only for a sender: pass sender (kind member, address, domain, or any_authenticated, and value except for any_authenticated) so the approval link names who it runs for. view.canApprove false lists what to fix first in view.changes[].error, view.enable[].error, and view.errors (unknown need or trigger, unminted webhook, missing or ambiguous credential with a createUrl, kind or provider mismatch, org defaults without package:write). Once the person approves, credentialTriggerPickSet can set those trigger picks again later. Needs package:execute on the package.',
		keywords: [
			'credential',
			'credentials',
			'mapping',
			'default',
			'propose',
			'approve',
			'approval',
			'trigger',
			'package',
		],
		readOnly: false,
		idempotent: false,
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
				defaults: needPicksSchema
					.optional()
					.describe('Org default mappings, keyed by need key.'),
				mine: needPicksSchema
					.optional()
					.describe('Your own default mappings, keyed by need key.'),
				triggers: z
					.array(
						z.object({
							kind: z.enum(credentialTriggerKinds),
							name: z
								.string()
								.min(1)
								.describe('Job name, subscription topic, or webhook name.'),
							credentials: needPicksSchema.describe(
								'Mappings for your instance of this trigger, keyed by need key.',
							),
						}),
					)
					.optional(),
				enable: z
					.array(
						z.object({
							kind: z.enum(credentialTriggerKinds),
							name: z
								.string()
								.min(1)
								.describe('Job name, subscription topic, or webhook name.'),
						}),
					)
					.optional()
					.describe(
						'Triggers to turn on for the approver even though they map nothing, such as a webhook with no credential needs.',
					),
				reason: z
					.string()
					.max(500)
					.optional()
					.describe('Shown to the approver as an untrusted note.'),
				sender: z
					.object({
						kind: z.enum(credentialProposalSenderKinds),
						value: z
							.string()
							.nullable()
							.optional()
							.describe(
								'Person id, email address, or bare domain. Omit for any_authenticated.',
							),
					})
					.optional()
					.describe(
						'Sender an inbound-email subscription runs for. Required when enabling email.message.received or email.message.quarantined.',
					),
			})
			.refine((input) => Boolean(input.packageId ?? input.kodyId), {
				message: 'Provide packageId or kodyId.',
				path: ['packageId'],
			}),
		outputSchema: z.object({
			approvalUrl: z.string(),
			view: viewSchema,
			message: z.string(),
		}),
		async handler(args, ctx: CapabilityContext) {
			const request = requireMcpRequest(ctx.callerContext)
			const { authorityPackageId } = resolveCallerSecretAuthority({
				storageContext: ctx.callerContext.storageContext,
			})
			if (authorityPackageId) {
				throw new McpCallerError(
					'Package code cannot propose credential mappings. Ask the person to map credentials on the package page.',
				)
			}
			if (!request.actor) {
				throw new McpCallerError(
					'Proposing credential mappings needs a signed-in person.',
				)
			}
			const username = request.org.slug
			if (!username) {
				throw new McpCallerError(
					'This org has no username, so it has no approval page.',
				)
			}
			const changes = proposalChanges(args)
			const enable = args.enable ?? []
			if (changes.length === 0 && enable.length === 0) {
				throw new McpCallerError(
					'Propose at least one mapping in defaults, mine, or triggers, or a trigger to enable.',
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
			const sender = proposalSender(args.sender)
			const href = buildCredentialApprovalHref({
				username,
				kodyId: scope.savedPackage.kodyId,
				changes,
				enable,
				reason: args.reason ?? null,
				sender,
			})
			// Resolve what the page will read back, so the view matches it.
			const proposal = parseCredentialApprovalQuery(
				new URL(href, ctx.callerContext.baseUrl).searchParams,
			)
			const { view } = await resolveCredentialApproval(scope, proposal)
			const agent = proposingAgentFor(request)
			const proposalId =
				agent && view.canApprove
					? await recordCredentialProposal({
							db: ctx.env.APP_DB,
							orgId: request.org.id,
							packageId: scope.savedPackage.id,
							agent,
							proposal,
						})
					: null
			const approvalUrl = new URL(
				proposalId
					? buildCredentialApprovalHref({
							username,
							kodyId: scope.savedPackage.kodyId,
							changes,
							enable,
							reason: args.reason ?? null,
							sender,
							proposalId,
						})
					: href,
				ctx.callerContext.baseUrl,
			).toString()
			return {
				approvalUrl,
				view,
				message: view.canApprove
					? `Send this link to the person to review and approve: ${approvalUrl}`
					: 'This proposal cannot be approved yet. Fix the errors in view.changes[].error, view.enable[].error, and view.errors (createUrl links create a missing credential), then propose again.',
			}
		},
	},
)
