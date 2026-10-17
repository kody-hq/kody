import {
	dismissAdminCommunityReport,
	delistAdminCommunityReport,
	deleteAdminCommunityReport,
	banAdminReportReporter,
	banAdminReportOwner,
} from '#worker/admin/community-reports-operations.ts'
import { type CommunityReportRecord } from '#worker/community/types.ts'
import { adminOperationOutcome } from '#worker/test-support/admin-operation-outcome.ts'
import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'

const mockModule = vi.hoisted(() => ({
	requireUserWithRole: vi.fn(),
	getCommunityReportById: vi.fn(),
	resolveCommunityReport: vi.fn(),
	banCommunityUser: vi.fn(),
	listCommunityReports: vi.fn(),
}))

vi.mock('#app/permissions-server.ts', () => ({
	requireUserWithRole: (...args: Array<unknown>) =>
		mockModule.requireUserWithRole(...args),
}))

vi.mock('#worker/community/repo.ts', () => ({
	getCommunityReportById: (...args: Array<unknown>) =>
		mockModule.getCommunityReportById(...args),
}))

vi.mock('#worker/community/service.ts', () => ({
	listCommunityReports: (...args: Array<unknown>) =>
		mockModule.listCommunityReports(...args),
	resolveCommunityReport: (...args: Array<unknown>) =>
		mockModule.resolveCommunityReport(...args),
	banCommunityUser: (...args: Array<unknown>) =>
		mockModule.banCommunityUser(...args),
}))

const sampleReport = {
	id: 'report-1',
	listingId: 'listing-1',
	listingName: '@owner/pkg',
	listingOwnerUserId: ownerIdFromStored('owner-mcp-id'),
	reporterUserId: ownerIdFromStored('reporter-mcp-id'),
	reason: 'Malware',
	status: 'open',
	resolvedByUserId: null,
	resolvedAt: null,
	resolutionNote: null,
	createdAt: '2026-01-01T00:00:00.000Z',
	updatedAt: '2026-01-01T00:00:00.000Z',
} satisfies CommunityReportRecord

const adminActor = {
	mcpUser: { userId: ownerIdFromStored('admin-mcp-id') },
}

const env = { APP_DB: {} } as Env

test('admin community reports POST dispatches moderation intents', async () => {
	mockModule.requireUserWithRole.mockResolvedValue(adminActor)
	mockModule.getCommunityReportById.mockResolvedValue(sampleReport)
	mockModule.resolveCommunityReport.mockResolvedValue(undefined)
	mockModule.banCommunityUser.mockResolvedValue(undefined)

	const mutate = (body: {
		intent: 'dismiss' | 'delist' | 'delete' | 'ban_reporter' | 'ban_reportee'
		reportId: string
		note?: string
	}) =>
		adminOperationOutcome(() => {
			const { intent, ...fields } = body
			const input = {
				env,
				request: new Request('https://example.com/admin/community-reports'),
				...fields,
			}
			switch (intent) {
				case 'dismiss':
					return dismissAdminCommunityReport(input)
				case 'delist':
					return delistAdminCommunityReport(input)
				case 'delete':
					return deleteAdminCommunityReport(input)
				case 'ban_reporter':
					return banAdminReportReporter(input)
				case 'ban_reportee':
					return banAdminReportOwner(input)
			}
		})

	const dismiss = await mutate({
		intent: 'dismiss',
		reportId: 'report-1',
		note: 'Looks fine',
	})
	expect(dismiss.status).toBe(200)
	expect(dismiss.data).toEqual({ ok: true })
	expect(mockModule.resolveCommunityReport).toHaveBeenCalledWith({
		env,
		adminUserId: 'admin-mcp-id',
		reportId: 'report-1',
		action: 'dismiss',
		resolutionNote: 'Looks fine',
	})
	expect(mockModule.banCommunityUser).not.toHaveBeenCalled()

	mockModule.resolveCommunityReport.mockClear()
	mockModule.banCommunityUser.mockClear()

	const banReporter = await mutate({
		intent: 'ban_reporter',
		reportId: 'report-1',
	})
	expect(banReporter.status).toBe(200)
	expect(mockModule.banCommunityUser).toHaveBeenCalledWith({
		env,
		adminUserId: 'admin-mcp-id',
		userId: ownerIdFromStored('reporter-mcp-id'),
		reason: 'Banned via community report moderation (report-1).',
	})
	expect(mockModule.resolveCommunityReport).not.toHaveBeenCalled()

	mockModule.banCommunityUser.mockClear()

	const banReportee = await mutate({
		intent: 'ban_reportee',
		reportId: 'report-1',
		note: 'Repeated abuse',
	})
	expect(banReportee.status).toBe(200)
	expect(mockModule.banCommunityUser).toHaveBeenCalledWith({
		env,
		adminUserId: 'admin-mcp-id',
		userId: ownerIdFromStored('owner-mcp-id'),
		reason: 'Repeated abuse',
	})

	mockModule.resolveCommunityReport.mockClear()

	await mutate({
		intent: 'delete',
		reportId: 'report-1',
	})

	expect(mockModule.resolveCommunityReport).toHaveBeenCalledWith({
		env,
		adminUserId: 'admin-mcp-id',
		reportId: 'report-1',
		action: 'delete',
		resolutionNote: undefined,
	})
})
