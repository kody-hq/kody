import { beforeEach, expect, test, vi } from 'vitest'
const state = vi.hoisted(() => ({
	context: vi.fn(),
	read: vi.fn(),
	audit: vi.fn(),
	head: vi.fn(),
}))
vi.mock('@tanstack/react-start', () => ({
	createServerFn: () => {
		let parse: (data: unknown) => unknown
		const builder = {
			validator(schema: { parse: (data: unknown) => unknown }) {
				parse = schema.parse
				return builder
			},
			handler(fn: (input: { data: unknown }) => unknown) {
				return (input: { data: unknown }) => fn({ data: parse(input.data) })
			},
		}
		return builder
	},
}))
vi.mock('./admin-page-context.ts', () => ({
	readAdminPageContext: state.context,
}))
vi.mock('./document-head.ts', () => ({ loadDocumentHead: state.head }))
vi.mock('../../src/app/admin-platform-feedback-data.ts', () => ({
	readAdminPlatformFeedbackData: state.read,
	readAdminPlatformFeedbackId: (id: string | null) => id?.trim() || null,
}))
vi.mock('../../src/app/admin-community-reports-data.ts', () => ({
	readAdminCommunityReportsData: state.read,
}))
vi.mock('../../src/admin/system-email-data.ts', () => ({
	readAdminSystemEmailData: state.read,
}))
vi.mock('../../src/app/admin-platform-integrations-data.ts', () => ({
	loadAdminPlatformIntegrationsData: state.read,
}))
vi.mock('../../src/admin/platform-feedback-operations.ts', () => ({
	auditPlatformFeedbackRead: state.audit,
}))
vi.mock('../../src/admin/system-email-operations.ts', () => ({
	auditSystemEmailAccess: state.audit,
}))
import { loadAdminPlatformFeedback } from './admin-platform-feedback.ts'
import { loadAdminCommunityReports } from './admin-community-reports.ts'
import { loadAdminSystemEmail } from './admin-system-email.ts'
import { loadAdminPlatformIntegrations } from './admin-platform-integrations.ts'
beforeEach(() => {
	vi.clearAllMocks()
	state.context.mockImplementation(async (returnTo: string) => ({
		bindings: {},
		request: new Request('https://kody.test/_serverFn/read'),
		url: new URL(returnTo, 'https://kody.test'),
		user: { email: 'admin@example.com' },
	}))
	state.read.mockResolvedValue({
		selectedFeedback: null,
		selectedMessage: null,
	})
})
test('feedback filters and selected record come from typed inputs, not return navigation', async () => {
	const data = {
		returnTo: '/admin/platform-feedback?feedbackId=other',
		page: 2,
		pageSize: 40,
		status: 'open',
		category: 'bug',
		feedbackId: 'target',
	}
	await loadAdminPlatformFeedback({ data })
	expect(state.read).toHaveBeenCalledWith({}, data)
	expect(state.audit).toHaveBeenCalledWith(
		expect.objectContaining({
			action: 'adminPlatformFeedbackGet',
			feedbackId: 'target',
			notFound: true,
			actorEmail: 'admin@example.com',
		}),
	)
})
test('system email selection and audit remain coupled to the actual selected message', async () => {
	state.read.mockResolvedValue({ selectedMessage: { id: 'message' } })
	await loadAdminSystemEmail({
		data: {
			returnTo: '/admin/system-email',
			page: 3,
			pageSize: 25,
			messageId: 'message',
		},
	})
	expect(state.read).toHaveBeenCalledWith(
		{},
		expect.objectContaining({ page: 3, messageId: 'message' }),
	)
	expect(state.audit).toHaveBeenCalledWith(
		expect.objectContaining({
			action: 'adminSystemEmailGet',
			reason: 'target_message_id=message',
		}),
	)
})
test('community status is explicit and platform integration metadata uses explicit view', async () => {
	await loadAdminCommunityReports({
		data: {
			returnTo: '/admin/community-reports?status=open',
			status: 'resolved',
		},
	})
	expect(state.read).toHaveBeenCalledWith(
		{},
		expect.objectContaining({ status: 'resolved' }),
	)
	await loadAdminPlatformIntegrations({
		data: { returnTo: '/admin/platform-integrations/new', view: 'new' },
	})
	expect(state.head).toHaveBeenLastCalledWith(
		'adminPlatformIntegrationNew',
		'/admin/platform-integrations/new',
		undefined,
		'',
	)
})
test('denied admin does not read or audit protected content', async () => {
	state.context.mockResolvedValue({
		bindings: {},
		url: new URL('https://kody.test/admin/platform-feedback'),
		user: null,
	})
	const result = await loadAdminPlatformFeedback({
		data: {
			returnTo: '/admin/platform-feedback',
			page: 1,
			pageSize: 20,
			status: null,
			category: null,
			feedbackId: null,
		},
	})
	expect(result.forbidden).toBe(true)
	expect(state.read).not.toHaveBeenCalled()
	expect(state.audit).not.toHaveBeenCalled()
})
