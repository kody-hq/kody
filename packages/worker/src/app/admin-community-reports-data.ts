import { type AdminCommunityReportsLoaderData } from '#universal/loader-data.ts'
import { listCommunityReports } from '#worker/community/service.ts'
import { type CommunityReportRecord } from '#worker/community/types.ts'

type AdminCommunityReportListItem = {
	id: string
	listingId: string
	listingName: string
	listingOwnerUserId: string
	reporterUserId: string
	reason: string
	status: CommunityReportRecord['status']
	createdAt: string
	resolvedAt: string | null
	resolutionNote: string | null
}

export async function loadAdminCommunityReportsData(
	env: Env,
	requestUrl: string,
): Promise<AdminCommunityReportsLoaderData> {
	const url = new URL(requestUrl, 'http://localhost')
	const rawStatusFilter = url.searchParams.get('status') ?? 'open'
	return readAdminCommunityReportsData(env, { status: rawStatusFilter })
}
export async function readAdminCommunityReportsData(
	env: Env,
	input: { status: string | null },
): Promise<AdminCommunityReportsLoaderData> {
	const statusFilter = normalizeReportStatusFilter(input.status ?? 'open')
	const reports = await loadAdminCommunityReports(env, statusFilter)
	return {
		ok: true,
		reports,
		statusFilter,
	}
}

async function loadAdminCommunityReports(
	env: Env,
	statusFilter: string,
): Promise<Array<AdminCommunityReportListItem>> {
	if (statusFilter === 'all') {
		const reports = await listCommunityReports({ env })
		return reports.map(toAdminCommunityReportListItem)
	}

	const status = readReportStatusFilter(statusFilter)
	const reports = await listCommunityReports({
		env,
		status,
	})
	return reports.map(toAdminCommunityReportListItem)
}

function normalizeReportStatusFilter(statusFilter: string): string {
	if (statusFilter === 'all') return 'all'
	return readReportStatusFilter(statusFilter)
}

function readReportStatusFilter(
	statusFilter: string,
): CommunityReportRecord['status'] {
	switch (statusFilter) {
		case 'open':
		case 'resolved':
		case 'dismissed':
			return statusFilter
		default:
			return 'open'
	}
}

function toAdminCommunityReportListItem(
	report: CommunityReportRecord,
): AdminCommunityReportListItem {
	return {
		id: report.id,
		listingId: report.listingId,
		listingName: report.listingName,
		listingOwnerUserId: report.listingOwnerUserId,
		reporterUserId: report.reporterUserId,
		reason: report.reason,
		status: report.status,
		createdAt: report.createdAt,
		resolvedAt: report.resolvedAt,
		resolutionNote: report.resolutionNote,
	}
}
