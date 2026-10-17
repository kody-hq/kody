import { z } from 'zod'
import { credentialPickSchema } from './credential-pick-schema.ts'
import {
	credentialTriggerKinds,
	credentialProposalSenderKinds,
	maxCredentialProposalValues,
	maxCredentialProposalReasonLength,
	normalizeProposalSenderValue,
} from './credential-contracts.ts'
const credentialTriggerRefSchema = z
	.strictObject({
		kind: z.enum(credentialTriggerKinds),
		name: z.string().trim().min(1),
		endpointId: z.string().trim().min(1).optional(),
	})
	.refine((ref) => !ref.endpointId || ref.kind === 'webhook', {
		message: 'Only webhook triggers can select an endpoint.',
	})
const credentialMappingChangeSchema = z.strictObject({
	target: z.discriminatedUnion('type', [
		z.strictObject({
			type: z.literal('default'),
			layer: z.enum(['org', 'mine']),
		}),
		z.strictObject({
			type: z.literal('trigger'),
			enablementId: z.string().trim().min(1).optional(),
			createInstance: z.boolean().optional(),
			trigger: credentialTriggerRefSchema,
		}),
	]),
	needKey: z.string().trim().min(1),
	credentials: z
		.array(credentialPickSchema)
		.max(maxCredentialProposalValues)
		.nullable(),
})

export const credentialMappingChangesSchema = z.strictObject({
	changes: z
		.array(credentialMappingChangeSchema)
		.min(1)
		.max(maxCredentialProposalValues),
})

export const credentialProposalSchema = z
	.strictObject({
		changes: z
			.array(
				credentialMappingChangeSchema.extend({
					credentials: z
						.array(credentialPickSchema)
						.max(maxCredentialProposalValues),
				}),
			)
			.max(maxCredentialProposalValues),
		enable: z
			.array(credentialTriggerRefSchema)
			.max(maxCredentialProposalValues),
		sender: z
			.strictObject({
				kind: z.enum(credentialProposalSenderKinds),
				value: z.string().nullable(),
			})
			.transform((sender, context) => {
				if (sender.kind === 'any_authenticated')
					return { kind: sender.kind, value: null }
				const value = normalizeProposalSenderValue(
					sender.kind,
					sender.value ?? '',
				)
				if (!value) {
					context.addIssue({
						code: 'custom',
						message: 'Invalid proposal sender.',
					})
					return z.NEVER
				}
				return { kind: sender.kind, value }
			})
			.nullable(),
		reason: z.string().max(maxCredentialProposalReasonLength).nullable(),
		errors: z.array(z.string()),
	})
	.refine(
		(proposal) =>
			proposal.changes.length + proposal.enable.length <=
			maxCredentialProposalValues,
		'Too many proposal changes.',
	)

const enablementActionSchema = z.strictObject({
	trigger: z.strictObject({
		kind: z.enum(credentialTriggerKinds),
		name: z.string().trim().min(1),
	}),
	state: z.enum(['on', 'off']),
	enablementId: z.string().trim().min(1).optional(),
	createInstance: z.boolean().optional(),
})

export const packageCredentialChangesSchema = z
	.strictObject({
		changes: z
			.array(credentialMappingChangeSchema)
			.max(maxCredentialProposalValues)
			.optional(),
		enablements: z.array(enablementActionSchema).max(16).optional(),
	})
	.refine(
		(body) =>
			(body.changes?.length ?? 0) > 0 || (body.enablements?.length ?? 0) > 0,
		{ message: 'expected { changes } and/or { enablements }' },
	)
