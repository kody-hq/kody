import { z } from 'zod'
import { McpCallerError } from '#mcp/caller-error.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { enqueuePlatformFeedbackDispatch } from '#worker/platform-feedback/dispatch-queue-producer.ts'
import { isPlatformFeedbackDomainError } from '#worker/platform-feedback/errors.ts'
import { submitPlatformFeedback } from '#worker/platform-feedback/service.ts'
import { platformFeedbackCategories } from '#worker/platform-feedback/types.ts'
import { requireMcpUser } from './require-user.ts'

const interactiveApprovalErrorMessage =
	'Platform feedback submission is only available from an interactive MCP agent flow after explicit user approval. Non-interactive package code and package apps cannot submit feedback.'

export const metaPlatformFeedbackSubmitCapability = defineDomainCapability(
	capabilityDomainNames.meta,
	{
		name: 'metaPlatformFeedbackSubmit',
		orgPermission: 'none',
		description:
			'Submit platform feedback only from an interactive MCP agent flow after showing the user the exact proposed summary and details, asking first, and receiving explicit approval. Open `search({ entity: "guide:platform_friction" })` first for the approval flow and content guidance. After submit, use metaPlatformFeedbackGet with the returned feedback_id (or metaPlatformFeedbackList) to check status — including open, triaged, resolved, and dismissed — without a full account export. The exact approved summary and details plus the account user id, username, and email may be delivered immediately to deployment admins through admin-configured notifications. Copies already delivered outside Kody may remain after Kody account deletion under the deployment operator’s retention and deletion controls. Non-interactive package code and package apps cannot submit. Do not include secrets or unrelated private content.',
		keywords: [
			'platform feedback',
			'friction',
			'bug report',
			'experience',
			'suggestion',
		],
		readOnly: false,
		idempotent: false,
		destructive: false,
		inputSchema: z.strictObject({
			category: z
				.enum(platformFeedbackCategories)
				.describe(
					'Stable feedback category: "bug" for reproducible defects, "friction" for capability/guide/package text that caused a wrong turn, "experience" for a poor overall experience, "suggestion" for a problem-first improvement idea, "cancellation" for why the user is ending a paid subscription, "other" when nothing fits.',
				),
			summary: z
				.string()
				.trim()
				.min(1)
				.max(200)
				.describe(
					'Specific, scannable summary naming the affected area and symptom or need (1–200 characters); admins triage from this line alone, so avoid vague summaries like "search is broken".',
				),
			details: z
				.string()
				.trim()
				.min(1)
				.max(8000)
				.describe(
					'Feedback details (1–8000 characters), one issue per submission: goal context, exact capability or package names, minimal reproduction steps, expected vs actual behavior, verbatim error text, frequency, impact, and any workaround. Do not include secrets or unrelated private content.',
				),
			user_confirmed: z
				.literal(true)
				.describe(
					'Must be true only after the agent shows the exact proposed summary and details and the user explicitly approves sending them, with the account user id, username, and email, immediately to deployment admins through admin-configured notifications, after being told that copies already delivered outside Kody may remain after Kody account deletion under the deployment operator’s retention and deletion controls.',
				),
		}),
		outputSchema: z.object({
			feedback_id: z
				.string()
				.describe(
					"Submitted feedback id. Pass to metaPlatformFeedbackGet to check status later, or use metaPlatformFeedbackList to browse the signed-in user's submissions.",
				),
			status: z.literal('open'),
			created_at: z.string(),
		}),
		async handler(args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			if (ctx.callerContext.executionOrigin !== 'interactive') {
				throw new Error(interactiveApprovalErrorMessage)
			}
			const packageId =
				ctx.callerContext.storageContext?.packageId?.trim() ?? ''
			if (packageId) {
				throw new Error(interactiveApprovalErrorMessage)
			}
			const submitterUsername = user.username?.trim()
			if (!submitterUsername) {
				throw new Error(
					'Platform feedback requires an authenticated account username.',
				)
			}
			let feedback
			try {
				feedback = await submitPlatformFeedback({
					db: ctx.env.APP_DB,
					submitterUserId: user.userId,
					submitterUsername,
					submitterEmail: user.email,
					category: args.category,
					summary: args.summary,
					details: args.details,
				})
			} catch (error) {
				// Rate limits, active-queue caps, and concurrent conflicts are
				// caller-clearable; keep them off Sentry as user errors.
				if (isPlatformFeedbackDomainError(error)) {
					throw new McpCallerError(error.message, { cause: error })
				}
				throw error
			}
			try {
				await enqueuePlatformFeedbackDispatch({
					queue: ctx.env.PLATFORM_FEEDBACK_DISPATCH_QUEUE,
					feedbackId: feedback.id,
				})
			} catch (error) {
				console.error('platform-feedback-dispatch-enqueue-failed', error)
			}
			return {
				feedback_id: feedback.id,
				status: 'open' as const,
				created_at: feedback.createdAt,
			}
		},
	},
)
