import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import type * as PlatformFeedbackOutcomeEmail from '#worker/platform-feedback/outcome-email.ts'
import type * as PlatformFeedbackService from '#worker/platform-feedback/service.ts'
import type * as PlatformFeedbackSubmitterMail from '#worker/platform-feedback/submitter-mail.ts'
import { expect, test, vi } from 'vitest'
import { McpCallerError } from '#mcp/caller-error.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import {
	PlatformFeedbackActiveQueueLimitError,
	PlatformFeedbackInvalidTransitionError,
	PlatformFeedbackNotFoundError,
	PlatformFeedbackSubmissionRateLimitError,
} from '#worker/platform-feedback/errors.ts'
import {
	auditEventSummaries,
	logAuditEventSpy,
} from '#worker/test-support/audit-log-spy.ts'
import {
	consoleError,
	consoleWarn,
} from '#worker/test-support/console-spies.ts'
import { adminPlatformFeedbackGetCapability } from './admin/admin-platform-feedback-get.ts'
import { adminPlatformFeedbackListCapability } from './admin/admin-platform-feedback-list.ts'
import { adminPlatformFeedbackUpdateCapability } from './admin/admin-platform-feedback-update.ts'
import { platformFeedbackContentWarning } from './admin/platform-feedback-shared.ts'
import {
	platformFeedbackActiveQueueLimit,
	platformFeedbackSubmissionRateLimit,
} from '#worker/platform-feedback/limits.ts'
import { metaPlatformFeedbackGetCapability } from './meta/meta-platform-feedback-get.ts'
import { metaPlatformFeedbackListCapability } from './meta/meta-platform-feedback-list.ts'
import { metaPlatformFeedbackSubmitCapability } from './meta/meta-platform-feedback-submit.ts'

const mockModule = vi.hoisted(() => ({
	getPlatformFeedbackForAdmin: vi.fn(),
	getPlatformFeedbackForSubmitter: vi.fn(),
	listPlatformFeedbackForAdmin: vi.fn(),
	listPlatformFeedbackForSubmitter: vi.fn(),
	queueSend: vi.fn(),
	readPlatformFeedbackSubmitterContact: vi.fn(),
	recordPlatformFeedbackFollowUpForAdmin: vi.fn(),
	sendPlatformFeedbackOutcomeEmail: vi.fn(),
	submitPlatformFeedback: vi.fn(),
	updatePlatformFeedbackForAdmin: vi.fn(),
}))

const synchronousFanOutModule = vi.hoisted(() => ({
	loaded: false,
	dispatchPlatformFeedbackSubmittedSubscriptionEvent: vi.fn(),
}))

vi.mock('#worker/platform-feedback/package-subscriptions.ts', () => {
	synchronousFanOutModule.loaded = true
	return {
		dispatchPlatformFeedbackSubmittedSubscriptionEvent:
			synchronousFanOutModule.dispatchPlatformFeedbackSubmittedSubscriptionEvent,
	}
})

vi.mock(
	'#worker/platform-feedback/outcome-email.ts',
	async (importOriginal) => {
		const actual = await importOriginal<typeof PlatformFeedbackOutcomeEmail>()
		return {
			...actual,
			sendPlatformFeedbackOutcomeEmail: (...args: Array<unknown>) =>
				mockModule.sendPlatformFeedbackOutcomeEmail(...args),
		}
	},
)

vi.mock(
	'#worker/platform-feedback/submitter-mail.ts',
	async (importOriginal) => {
		const actual = await importOriginal<typeof PlatformFeedbackSubmitterMail>()
		return {
			...actual,
			readPlatformFeedbackSubmitterContact: async (...args: Array<unknown>) =>
				(await mockModule.readPlatformFeedbackSubmitterContact(...args)) ?? {
					reachable: true,
					emailVerified: true,
					unreachableReason: null,
				},
		}
	},
)

const reachableContact = {
	reachable: true,
	emailVerified: true,
	unreachableReason: null,
}

vi.mock('#worker/platform-feedback/service.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof PlatformFeedbackService>()
	return {
		...actual,
		getPlatformFeedbackForAdmin: (...args: Array<unknown>) =>
			mockModule.getPlatformFeedbackForAdmin(...args),
		getPlatformFeedbackForSubmitter: (...args: Array<unknown>) =>
			mockModule.getPlatformFeedbackForSubmitter(...args),
		listPlatformFeedbackForAdmin: (...args: Array<unknown>) =>
			mockModule.listPlatformFeedbackForAdmin(...args),
		listPlatformFeedbackForSubmitter: (...args: Array<unknown>) =>
			mockModule.listPlatformFeedbackForSubmitter(...args),
		submitPlatformFeedback: (...args: Array<unknown>) =>
			mockModule.submitPlatformFeedback(...args),
		recordPlatformFeedbackFollowUpForAdmin: (...args: Array<unknown>) =>
			mockModule.recordPlatformFeedbackFollowUpForAdmin(...args),
		updatePlatformFeedbackForAdmin: (...args: Array<unknown>) =>
			mockModule.updatePlatformFeedbackForAdmin(...args),
	}
})

const openFeedback = {
	id: 'feedback-1',
	submitterUserId: 'user-1',
	submitterUsername: 'user-1-name',
	submitterEmail: 'user-1@example.com',
	category: 'friction' as const,
	summary: 'Setup is confusing',
	details: 'The setup flow does not explain the next action.',
	status: 'open' as const,
	reviewedByUserId: null,
	reviewedAt: null,
	adminNote: null,
	resolutionNote: null,
	resolutionPrUrls: [] as Array<string>,
	resolutionHistory: [],
	createdAt: '2026-07-19T00:00:00.000Z',
	updatedAt: '2026-07-19T00:00:00.000Z',
}

function createActingAdminAppDb(userId: string): D1Database {
	const stableUserId = personIdFromStored(userId)
	return {
		prepare(_sql: string) {
			return {
				bind(lookupId: string) {
					return {
						async first() {
							if (lookupId !== stableUserId) return null
							return {
								id: 1,
								email: `${userId}@example.com`,
								username: `${userId}-name`,
							}
						},
					}
				},
			}
		},
	} as unknown as D1Database
}

function createCapabilityContext(input?: {
	userId?: string
	roles?: Array<string>
	packageId?: string
	executionOrigin?: 'interactive' | 'background'
}) {
	const userId = input?.userId ?? 'user-1'
	return {
		env: {
			APP_DB: createActingAdminAppDb(userId),
			PLATFORM_FEEDBACK_DISPATCH_QUEUE: {
				send: mockModule.queueSend,
			},
		} as unknown as Env,
		callerContext: createMcpCallerContext({
			source: { kind: 'mcp-oauth' },
			baseUrl: 'https://heykody.dev',
			executionOrigin: input?.executionOrigin,
			storageContext:
				input?.packageId === undefined
					? undefined
					: {
							sessionId: null,
							appId: 'package-app-1',
							packageId: input.packageId,
							storageId: null,
						},
			...(input
				? {
						user: {
							userId: personIdFromStored(userId),
							username: `${userId}-name`,
							email: `${userId}@example.com`,
							displayName: `${userId}-name`,
							roles: input.roles,
						},
					}
				: {}),
		}),
	}
}

test('meta platform feedback submission gates consent and isolates post-persistence enqueue failures', async () => {
	mockModule.submitPlatformFeedback.mockResolvedValue(openFeedback)
	const input = {
		category: 'friction' as const,
		summary: '  Setup is confusing  ',
		details: '  The setup flow does not explain the next action.  ',
		user_confirmed: true as const,
	}

	await expect(
		metaPlatformFeedbackSubmitCapability.handler(
			input,
			createCapabilityContext(),
		),
	).rejects.toThrow('Authenticated MCP user is required')
	for (const invalid of [
		{ ...input, user_confirmed: false },
		{ ...input, metadata: { conversation: 'private' } },
	]) {
		await expect(
			metaPlatformFeedbackSubmitCapability.handler(
				invalid as never,
				createCapabilityContext({ userId: ownerIdFromStored('user-1') }),
			),
		).rejects.toThrow(
			'Invalid input for capability "metaPlatformFeedbackSubmit"',
		)
	}
	// Omitted origin, background, and package-app callers are all refused.
	for (const context of [
		{ userId: ownerIdFromStored('user-1') },
		{
			userId: ownerIdFromStored('user-1'),
			executionOrigin: 'background' as const,
		},
		{
			userId: ownerIdFromStored('user-1'),
			packageId: 'package-1',
			executionOrigin: 'interactive' as const,
		},
	]) {
		await expect(
			metaPlatformFeedbackSubmitCapability.handler(
				input,
				createCapabilityContext(context),
			),
		).rejects.toThrow(
			'only available from an interactive MCP agent flow after explicit user approval',
		)
	}
	expect(mockModule.submitPlatformFeedback).not.toHaveBeenCalled()
	expect(mockModule.queueSend).not.toHaveBeenCalled()
	expect(synchronousFanOutModule.loaded).toBe(false)
	expect(
		synchronousFanOutModule.dispatchPlatformFeedbackSubmittedSubscriptionEvent,
	).not.toHaveBeenCalled()

	const interactive = createCapabilityContext({
		userId: ownerIdFromStored('user-1'),
		executionOrigin: 'interactive',
	})
	mockModule.submitPlatformFeedback.mockRejectedValueOnce(
		new PlatformFeedbackSubmissionRateLimitError(
			platformFeedbackSubmissionRateLimit,
			3600,
		),
	)
	await expect(
		metaPlatformFeedbackSubmitCapability.handler(input, interactive),
	).rejects.toSatisfy(
		(error: unknown) =>
			error instanceof McpCallerError &&
			error.message.includes('rolling 24 hours') &&
			error.cause instanceof PlatformFeedbackSubmissionRateLimitError,
	)
	expect(mockModule.queueSend).not.toHaveBeenCalled()

	mockModule.submitPlatformFeedback.mockRejectedValueOnce(
		new PlatformFeedbackActiveQueueLimitError(platformFeedbackActiveQueueLimit),
	)
	await expect(
		metaPlatformFeedbackSubmitCapability.handler(input, interactive),
	).rejects.toSatisfy(
		(error: unknown) =>
			error instanceof McpCallerError &&
			error.message.includes(
				`${platformFeedbackActiveQueueLimit} open or triaged`,
			) &&
			error.cause instanceof PlatformFeedbackActiveQueueLimitError,
	)
	expect(mockModule.queueSend).not.toHaveBeenCalled()

	const result = await metaPlatformFeedbackSubmitCapability.handler(
		input,
		interactive,
	)
	expect(mockModule.submitPlatformFeedback).toHaveBeenCalledWith(
		expect.objectContaining({
			submitterUserId: 'user-1',
			summary: 'Setup is confusing',
		}),
	)
	expect(mockModule.queueSend).toHaveBeenCalledWith({
		feedbackId: openFeedback.id,
	})
	expect(result.feedback_id).toBe('feedback-1')

	consoleError.mockImplementation(() => {})
	mockModule.queueSend.mockRejectedValueOnce(new Error('Queue unavailable'))
	await expect(
		metaPlatformFeedbackSubmitCapability.handler(input, interactive),
	).resolves.toEqual(result)
	expect(mockModule.queueSend).toHaveBeenCalledWith({
		feedbackId: openFeedback.id,
	})
	expect(consoleError).toHaveBeenCalledWith(
		'platform-feedback-dispatch-enqueue-failed',
		expect.any(Error),
	)
	expect(consoleError).toHaveBeenCalledTimes(1)
	expect(synchronousFanOutModule.loaded).toBe(false)
	expect(logAuditEventSpy).not.toHaveBeenCalled()
})

test('admin platform feedback capabilities enforce role access, redact lists, paginate, and audit', async () => {
	await expect(
		adminPlatformFeedbackListCapability.handler(
			{},
			createCapabilityContext({
				userId: ownerIdFromStored('member-1'),
				roles: ['user'],
			}),
		),
	).rejects.toThrow('lacks required role "admin"')
	expect(mockModule.listPlatformFeedbackForAdmin).not.toHaveBeenCalled()
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			category: 'auth',
			action: 'mcp_capability_denied',
			result: 'failure',
			reason: 'role',
		}),
	)

	mockModule.listPlatformFeedbackForAdmin.mockResolvedValue({
		total: 3,
		page: 2,
		pageSize: 1,
		items: [openFeedback],
	})
	mockModule.getPlatformFeedbackForAdmin.mockResolvedValue(openFeedback)
	const triagedFeedback = {
		...openFeedback,
		status: 'triaged' as const,
		reviewedByUserId: 'admin-1',
		reviewedAt: '2026-07-19T01:00:00.000Z',
		adminNote: 'Needs setup review.',
		updatedAt: '2026-07-19T01:00:00.000Z',
	}
	mockModule.updatePlatformFeedbackForAdmin.mockResolvedValue({
		feedback: triagedFeedback,
		previousStatus: 'open',
		didChangeStatus: true,
	})
	const adminContext = createCapabilityContext({
		userId: ownerIdFromStored('admin-1'),
		roles: ['admin'],
	})

	const list = await adminPlatformFeedbackListCapability.handler(
		{ page: 2, pageSize: 1, status: 'open', category: 'friction' },
		adminContext,
	)
	expect(list).toMatchObject({
		total: 3,
		page: 2,
		pageSize: 1,
		content_warning: platformFeedbackContentWarning,
	})
	expect(list.feedback[0]).not.toHaveProperty('summary')
	expect(list.feedback[0]).not.toHaveProperty('details')
	expect(list.feedback[0]).not.toHaveProperty('admin_note')

	const get = await adminPlatformFeedbackGetCapability.handler(
		{ id: 'feedback-1' },
		adminContext,
	)
	expect(get.feedback).toMatchObject({
		id: 'feedback-1',
	})
	expect(get.feedback).not.toHaveProperty('summary')
	expect(get.feedback).not.toHaveProperty('details')

	const updated = await adminPlatformFeedbackUpdateCapability.handler(
		{
			id: 'feedback-1',
			action: 'triage',
			admin_note: 'Needs setup review.',
		},
		adminContext,
	)
	expect(updated.feedback).toMatchObject({
		id: 'feedback-1',
		status: 'triaged',
		admin_note: 'Needs setup review.',
	})
	expect(updated.content_warning).toBe(platformFeedbackContentWarning)
	expect(mockModule.sendPlatformFeedbackOutcomeEmail).not.toHaveBeenCalled()
	mockModule.updatePlatformFeedbackForAdmin.mockRejectedValueOnce(
		new PlatformFeedbackInvalidTransitionError({
			feedbackId: 'feedback-1',
			status: 'resolved',
			action: 'dismiss',
		}),
	)
	await expect(
		adminPlatformFeedbackUpdateCapability.handler(
			{ id: 'feedback-1', action: 'dismiss' },
			adminContext,
		),
	).rejects.toSatisfy(
		(error: unknown) =>
			error instanceof McpCallerError &&
			error.cause instanceof PlatformFeedbackInvalidTransitionError,
	)
	mockModule.updatePlatformFeedbackForAdmin.mockRejectedValueOnce(
		new PlatformFeedbackNotFoundError('missing-feedback'),
	)
	await expect(
		adminPlatformFeedbackUpdateCapability.handler(
			{
				id: 'missing-feedback',
				action: 'triage',
			},
			adminContext,
		),
	).rejects.toSatisfy(
		(error: unknown) =>
			error instanceof McpCallerError &&
			error.cause instanceof PlatformFeedbackNotFoundError,
	)
	expect(auditEventSummaries()).toContain('adminPlatformFeedbackUpdate:success')
})

test('admin platform feedback resolve and dismiss email the submitter without failing the update', async () => {
	mockModule.readPlatformFeedbackSubmitterContact.mockResolvedValue(
		reachableContact,
	)
	mockModule.getPlatformFeedbackForAdmin.mockResolvedValue(openFeedback)
	mockModule.sendPlatformFeedbackOutcomeEmail.mockResolvedValue({ sent: true })
	const reviewed = {
		reviewedByUserId: 'admin-1',
		reviewedAt: '2026-07-19T01:00:00.000Z',
		updatedAt: '2026-07-19T01:00:00.000Z',
	}
	const resolvedFeedback = {
		...openFeedback,
		...reviewed,
		status: 'resolved' as const,
	}
	const dismissedFeedback = {
		...openFeedback,
		...reviewed,
		id: 'feedback-2',
		status: 'dismissed' as const,
	}
	const adminContext = createCapabilityContext({
		userId: ownerIdFromStored('admin-1'),
		roles: ['admin'],
	})

	const resolvedWithOutcome = {
		...resolvedFeedback,
		adminNote: 'Internal only.',
		resolutionNote: 'We shipped a clearer setup path.',
		resolutionPrUrls: ['https://github.com/example/repo/pull/42'],
	}
	mockModule.updatePlatformFeedbackForAdmin.mockResolvedValueOnce({
		feedback: resolvedWithOutcome,
		previousStatus: 'open',
		didChangeStatus: true,
	})
	const resolved = await adminPlatformFeedbackUpdateCapability.handler(
		{
			id: 'feedback-1',
			action: 'resolve',
			admin_note: 'Internal only.',
			user_message: 'We shipped a clearer setup path.',
			pr_urls: ['https://github.com/example/repo/pull/42'],
		},
		adminContext,
	)
	expect(resolved.outcome_email).toEqual({ sent: true, reason: null })
	expect(resolved.submitter_contact).toEqual({
		reachable: true,
		email_verified: true,
		unreachable_reason: null,
	})
	expect(JSON.stringify(resolved)).not.toContain('@example.com')
	expect(resolved.feedback).toMatchObject({
		status: 'resolved',
		admin_note: 'Internal only.',
		resolution_note: 'We shipped a clearer setup path.',
		resolution_pr_urls: ['https://github.com/example/repo/pull/42'],
	})
	expect(mockModule.updatePlatformFeedbackForAdmin).toHaveBeenCalledWith({
		db: expect.anything(),
		feedbackId: 'feedback-1',
		reviewerUserId: 'admin-1',
		action: 'resolve',
		adminNote: 'Internal only.',
		resolutionNote: 'We shipped a clearer setup path.',
		resolutionPrUrls: ['https://github.com/example/repo/pull/42'],
	})
	expect(mockModule.sendPlatformFeedbackOutcomeEmail).toHaveBeenCalledWith({
		env: adminContext.env,
		feedback: resolvedWithOutcome,
		status: 'resolved',
		userMessage: 'We shipped a clearer setup path.',
		prUrls: ['https://github.com/example/repo/pull/42'],
	})

	mockModule.sendPlatformFeedbackOutcomeEmail.mockClear()
	mockModule.updatePlatformFeedbackForAdmin.mockResolvedValueOnce({
		feedback: resolvedFeedback,
		previousStatus: 'resolved',
		didChangeStatus: false,
	})
	const noop = await adminPlatformFeedbackUpdateCapability.handler(
		{ id: 'feedback-1', action: 'resolve' },
		adminContext,
	)
	expect(mockModule.sendPlatformFeedbackOutcomeEmail).not.toHaveBeenCalled()
	expect(noop.outcome_email).toEqual({
		sent: false,
		reason: expect.stringContaining('follow_up'),
	})

	mockModule.updatePlatformFeedbackForAdmin.mockResolvedValueOnce({
		feedback: dismissedFeedback,
		previousStatus: 'triaged',
		didChangeStatus: true,
	})
	const dismissed = await adminPlatformFeedbackUpdateCapability.handler(
		{ id: 'feedback-2', action: 'dismiss' },
		adminContext,
	)
	expect(dismissed.feedback.status).toBe('dismissed')
	expect(mockModule.sendPlatformFeedbackOutcomeEmail).toHaveBeenCalledWith({
		env: adminContext.env,
		feedback: dismissedFeedback,
		status: 'dismissed',
		userMessage: undefined,
		prUrls: [],
	})

	mockModule.sendPlatformFeedbackOutcomeEmail.mockReset()
	mockModule.sendPlatformFeedbackOutcomeEmail.mockRejectedValueOnce(
		new Error('smtp down'),
	)
	consoleWarn.mockImplementation(() => {})
	mockModule.updatePlatformFeedbackForAdmin.mockResolvedValueOnce({
		feedback: { ...dismissedFeedback, id: 'feedback-3' },
		previousStatus: 'open',
		didChangeStatus: true,
	})
	const stillUpdated = await adminPlatformFeedbackUpdateCapability.handler(
		{ id: 'feedback-3', action: 'dismiss' },
		adminContext,
	)
	expect(stillUpdated.feedback.id).toBe('feedback-3')
	expect(stillUpdated.feedback.status).toBe('dismissed')
	expect(stillUpdated.outcome_email).toEqual({
		sent: false,
		reason: 'the email provider request failed',
	})
	expect(consoleWarn).toHaveBeenCalledWith(
		'platform-feedback-outcome-email-failed',
		{
			feedbackId: 'feedback-3',
			status: 'dismissed',
			error: expect.any(Error),
		},
	)
})

test('admin platform feedback follow_up stores and emails a new note on closed feedback, failing loudly otherwise', async () => {
	const base = createCapabilityContext({
		userId: ownerIdFromStored('admin-1'),
		roles: ['admin'],
	})
	const adminContext = {
		...base,
		env: {
			...base.env,
			APP_BASE_URL: 'https://heykody.dev',
			BUNDLE_ARTIFACTS_KV: {},
			CLOUDFLARE_API_TOKEN: 'test-token',
			CLOUDFLARE_ACCOUNT_ID: 'test-account',
		} as unknown as Env,
	}
	const resolvedFeedback = {
		...openFeedback,
		status: 'resolved' as const,
		reviewedByUserId: 'admin-1',
		reviewedAt: '2026-07-19T01:00:00.000Z',
		resolutionNote: 'Shipped.',
		updatedAt: '2026-07-19T01:00:00.000Z',
	}
	const followedUp = {
		...resolvedFeedback,
		resolutionNote: 'Also fixed on mobile.',
		resolutionHistory: [
			{
				note: 'Shipped.',
				prUrls: [],
				recordedAt: '2026-07-19T01:00:00.000Z',
			},
		],
		updatedAt: '2026-07-20T00:00:00.000Z',
	}
	mockModule.getPlatformFeedbackForAdmin.mockResolvedValue(resolvedFeedback)
	mockModule.readPlatformFeedbackSubmitterContact.mockResolvedValue(
		reachableContact,
	)
	mockModule.recordPlatformFeedbackFollowUpForAdmin.mockResolvedValue({
		// A concurrent later follow-up may already show in the re-read record;
		// the email must still carry the note this call wrote.
		feedback: { ...followedUp, resolutionNote: 'A later admin note.' },
		didChange: true,
		followUp: {
			note: 'Also fixed on mobile.',
			prUrls: [],
			version: 'follow-up-v1',
		},
	})
	mockModule.sendPlatformFeedbackOutcomeEmail.mockReset()
	mockModule.sendPlatformFeedbackOutcomeEmail.mockResolvedValueOnce({
		sent: true,
	})
	const result = await adminPlatformFeedbackUpdateCapability.handler(
		{
			id: 'feedback-1',
			action: 'follow_up',
			user_message: 'Also fixed on mobile.',
		},
		adminContext,
	)
	expect(result.outcome_email).toEqual({ sent: true, reason: null })
	expect(result.feedback).toMatchObject({
		status: 'resolved',
		resolution_history: [{ note: 'Shipped.', pr_urls: [] }],
	})
	expect(mockModule.sendPlatformFeedbackOutcomeEmail).toHaveBeenCalledWith(
		expect.objectContaining({
			status: 'resolved',
			userMessage: 'Also fixed on mobile.',
			prUrls: [],
			followUpVersion: 'follow-up-v1',
		}),
	)

	mockModule.sendPlatformFeedbackOutcomeEmail.mockResolvedValueOnce({
		sent: false,
		reason: 'send_not_delivered',
	})
	await expect(
		adminPlatformFeedbackUpdateCapability.handler(
			{
				id: 'feedback-1',
				action: 'follow_up',
				user_message: 'Also fixed on mobile.',
			},
			adminContext,
		),
	).rejects.toThrow(/Stored the follow-up note.*email was not sent/)

	mockModule.recordPlatformFeedbackFollowUpForAdmin.mockClear()
	mockModule.readPlatformFeedbackSubmitterContact.mockResolvedValueOnce({
		reachable: false,
		emailVerified: false,
		unreachableReason: 'account_suspended',
	})
	await expect(
		adminPlatformFeedbackUpdateCapability.handler(
			{ id: 'feedback-1', action: 'follow_up', user_message: 'Hello again.' },
			adminContext,
		),
	).rejects.toThrow(/suspended\. Nothing was stored or emailed/)
	await expect(
		adminPlatformFeedbackUpdateCapability.handler(
			{ id: 'feedback-1', action: 'follow_up', user_message: 'Hello again.' },
			{ ...adminContext, env: base.env },
		),
	).rejects.toThrow(/not configured.*Nothing was stored or emailed/)
	await expect(
		adminPlatformFeedbackUpdateCapability.handler(
			{ id: 'feedback-1', action: 'follow_up', user_message: 'Hello again.' },
			{
				...adminContext,
				env: { ...adminContext.env, CLOUDFLARE_API_TOKEN: '' } as Env,
			},
		),
	).rejects.toThrow(/not configured.*Nothing was stored or emailed/)
	await expect(
		adminPlatformFeedbackUpdateCapability.handler(
			{ id: 'feedback-1', action: 'follow_up' },
			adminContext,
		),
	).rejects.toThrow(/non-empty user_message/)
	mockModule.getPlatformFeedbackForAdmin.mockResolvedValueOnce(openFeedback)
	await expect(
		adminPlatformFeedbackUpdateCapability.handler(
			{ id: 'feedback-1', action: 'follow_up', user_message: 'Hello again.' },
			adminContext,
		),
	).rejects.toSatisfy(
		(error: unknown) =>
			error instanceof McpCallerError && /status "open"/.test(error.message),
	)
	expect(
		mockModule.recordPlatformFeedbackFollowUpForAdmin,
	).not.toHaveBeenCalled()
	mockModule.getPlatformFeedbackForAdmin.mockReset()
})

test('meta platform feedback get and list scope to the signed-in submitter and redact reviewer fields', async () => {
	const owned = {
		id: 'feedback-1',
		category: 'friction' as const,
		summary: 'Setup is confusing',
		details: 'The setup flow does not explain the next action.',
		status: 'resolved' as const,
		resolutionNote: 'We shipped a clearer setup path.',
		resolutionPrUrls: ['https://github.com/example/repo/pull/42'],
		createdAt: '2026-07-19T00:00:00.000Z',
		updatedAt: '2026-07-19T02:00:00.000Z',
	}
	mockModule.getPlatformFeedbackForSubmitter.mockResolvedValueOnce(owned)
	mockModule.getPlatformFeedbackForSubmitter.mockResolvedValueOnce(null)
	mockModule.listPlatformFeedbackForSubmitter.mockResolvedValue({
		total: 1,
		page: 1,
		pageSize: 20,
		items: [
			{
				id: owned.id,
				category: owned.category,
				summary: owned.summary,
				status: owned.status,
				resolutionNote: owned.resolutionNote,
				resolutionPrUrls: owned.resolutionPrUrls,
				createdAt: owned.createdAt,
				updatedAt: owned.updatedAt,
			},
		],
		submissionQuota: {
			limit: platformFeedbackSubmissionRateLimit,
			remaining: platformFeedbackSubmissionRateLimit - 1,
			nextSlotAt: null,
		},
	})

	const context = createCapabilityContext({
		userId: ownerIdFromStored('user-1'),
	})
	const got = await metaPlatformFeedbackGetCapability.handler(
		{ feedback_id: 'feedback-1' },
		context,
	)
	expect(mockModule.getPlatformFeedbackForSubmitter).toHaveBeenCalledWith({
		db: expect.anything(),
		feedbackId: 'feedback-1',
		submitterUserId: 'user-1',
	})
	expect(got).toMatchObject({ id: 'feedback-1', status: 'resolved' })
	expect(got).not.toHaveProperty('reviewed_by_user_id')
	expect(got).not.toHaveProperty('reviewed_at')
	expect(got).not.toHaveProperty('admin_note')

	const notOwned = await metaPlatformFeedbackGetCapability.handler(
		{ feedback_id: 'feedback-other' },
		context,
	)
	expect(notOwned).toBeNull()
	expect(mockModule.getPlatformFeedbackForSubmitter).toHaveBeenLastCalledWith({
		db: expect.anything(),
		feedbackId: 'feedback-other',
		submitterUserId: 'user-1',
	})

	const listed = await metaPlatformFeedbackListCapability.handler(
		{ status: 'resolved' },
		context,
	)
	expect(mockModule.listPlatformFeedbackForSubmitter).toHaveBeenCalledWith({
		db: expect.anything(),
		submitterUserId: 'user-1',
		page: undefined,
		pageSize: undefined,
		status: 'resolved',
	})
	expect(listed).toEqual({
		total: 1,
		page: 1,
		page_size: 20,
		feedback: [
			{
				id: 'feedback-1',
				category: 'friction',
				summary: 'Setup is confusing',
				status: 'resolved',
				resolution_note: 'We shipped a clearer setup path.',
				resolution_pr_urls: ['https://github.com/example/repo/pull/42'],
				created_at: '2026-07-19T00:00:00.000Z',
				updated_at: '2026-07-19T02:00:00.000Z',
			},
		],
		submission_rate_limit: platformFeedbackSubmissionRateLimit,
		submissions_remaining: platformFeedbackSubmissionRateLimit - 1,
		next_slot_at: null,
	})
	expect(listed.feedback[0]).not.toHaveProperty('details')
	expect(listed.feedback[0]).not.toHaveProperty('admin_note')
	expect(listed.feedback[0]).not.toHaveProperty('reviewed_by_user_id')
	expect(listed.feedback[0]).not.toHaveProperty('reviewed_at')
})

test('meta platform feedback list surfaces at-cap quota with next_slot_at', async () => {
	mockModule.listPlatformFeedbackForSubmitter.mockResolvedValue({
		total: 0,
		page: 1,
		pageSize: 20,
		items: [],
		submissionQuota: {
			limit: platformFeedbackSubmissionRateLimit,
			remaining: 0,
			nextSlotAt: '2026-07-20T06:00:00.000Z',
		},
	})
	const listed = await metaPlatformFeedbackListCapability.handler(
		{},
		createCapabilityContext({
			userId: ownerIdFromStored('user-1'),
		}),
	)
	expect(listed).toMatchObject({
		submission_rate_limit: platformFeedbackSubmissionRateLimit,
		submissions_remaining: 0,
		next_slot_at: '2026-07-20T06:00:00.000Z',
		feedback: [],
	})
})
