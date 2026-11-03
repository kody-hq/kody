import { z } from 'zod'
import type { ApprovalViewer } from '#worker/approval-bundles/item-views.ts'
import { requireMcpRequest } from '#mcp/capabilities/meta/require-user.ts'
import type { CapabilityContext } from '#mcp/capabilities/types.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import { resolveCallerSecretAuthority } from '#mcp/secrets/secret-authority.ts'
import {
	approvalItemTypes,
	describeApprovalItem,
	type ApprovalItemView,
} from '#universal/approval-bundles.ts'

export const approvalItemTypeSchema = z.enum(approvalItemTypes)

export const approvalItemSchema = z.object({
	key: z
		.string()
		.describe(
			'Pass to approvalBundleCreate items to bundle exactly this approval.',
		),
	type: approvalItemTypeSchema.describe(
		'publish: a paused publish (credential needs changed, or going public). capabilities: an internet-visible package whose credentials or storage changed since approval. credential-picks: a recorded credentialMappingPropose proposal.',
	),
	title: z.string(),
	summary: z.string().describe('What approving does, in plain language.'),
	package: z
		.object({ id: z.string(), kodyId: z.string(), name: z.string() })
		.nullable(),
	grants: z.array(
		z.object({
			change: z.enum(['added', 'changed', 'removed']),
			label: z.string(),
			where: z.string().nullable(),
			kind: z.string().nullable(),
			provider: z.string().nullable(),
			hosts: z.array(z.string()),
			before: z.string().nullable(),
			after: z.string().nullable(),
			match: z.string().nullable(),
		}),
	),
	canApprove: z
		.boolean()
		.describe('False when something must be fixed first; see statusMessage.'),
	statusMessage: z.string().nullable(),
	description: z.string().describe('One-line text form of this item.'),
})

export function toApprovalItemOutput(item: ApprovalItemView) {
	return {
		key: item.key,
		type: item.type,
		title: item.title,
		summary: item.summary,
		package: item.package
			? {
					id: item.package.id,
					kodyId: item.package.kodyId,
					name: item.package.name,
				}
			: null,
		grants: item.grants,
		canApprove: item.canApprove,
		statusMessage: item.statusMessage,
		description: describeApprovalItem(item),
	}
}

/** The caller as an approval viewer, or null for package code and personless calls. */
export function optionalApprovalViewerForCaller(
	ctx: CapabilityContext,
): ApprovalViewer | null {
	const request = ctx.callerContext.request
	if (!request?.actor) return null
	const { authorityPackageId } = resolveCallerSecretAuthority({
		storageContext: ctx.callerContext.storageContext,
	})
	if (authorityPackageId) return null
	return { env: ctx.env, baseUrl: ctx.callerContext.baseUrl, request }
}

/** The caller as an approval viewer; package code and personless calls are refused. */
export function approvalViewerForCaller(
	ctx: CapabilityContext,
	action: string,
): ApprovalViewer {
	const request = requireMcpRequest(ctx.callerContext)
	const { authorityPackageId } = resolveCallerSecretAuthority({
		storageContext: ctx.callerContext.storageContext,
	})
	if (authorityPackageId) {
		throw new McpCallerError(
			`Package code cannot ${action}. Ask the person to review approvals in Kody.`,
		)
	}
	if (!request.actor) {
		throw new McpCallerError(`To ${action}, a signed-in person is needed.`)
	}
	return { env: ctx.env, baseUrl: ctx.callerContext.baseUrl, request }
}
