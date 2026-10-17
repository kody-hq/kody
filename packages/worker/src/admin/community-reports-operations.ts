import { adminOperationResult } from './operation-result.ts'
import { z } from 'zod'
import { requireUserWithRole } from '#app/permissions-server.ts'
import { CommunityActionError } from '#worker/community/errors.ts'
import {
	banCommunityUser,
	resolveCommunityReport,
} from '#worker/community/service.ts'
import { getCommunityReportById } from '#worker/community/repo.ts'

type ReportInput = {
	env: Env
	request: Request
	reportId: string
	note?: string
}
async function moderateReport(
	input: ReportInput,
	write: (context: {
		adminUserId: Awaited<
			ReturnType<typeof requireUserWithRole>
		>['mcpUser']['userId']
		report: NonNullable<Awaited<ReturnType<typeof getCommunityReportById>>>
		note?: string
	}) => Promise<void>,
	errorMessage: string,
) {
	const actor = await requireUserWithRole(input.request, input.env, 'admin')
	const parsed = z
		.object({ reportId: z.string().min(1), note: z.string().optional() })
		.safeParse(input)
	if (!parsed.success)
		return adminOperationResult(
			{
				ok: false,
				error: parsed.error.issues[0]?.message ?? 'Invalid request body.',
			},
			400,
		)
	const report = await getCommunityReportById(
		input.env.APP_DB,
		parsed.data.reportId,
	)
	if (!report)
		return adminOperationResult({ ok: false, error: 'Report not found.' }, 404)
	try {
		await write({
			adminUserId: actor.mcpUser.userId,
			report,
			note: parsed.data.note?.trim() || undefined,
		})
	} catch (error) {
		if (error instanceof CommunityActionError)
			return adminOperationResult({ ok: false, error: error.message }, 400)
		console.error(errorMessage, error)
		return adminOperationResult({ ok: false, error: errorMessage }, 500)
	}
	return adminOperationResult({ ok: true })
}
export async function dismissAdminCommunityReport(input: ReportInput) {
	return moderateReport(
		input,
		async ({ adminUserId, note }) => {
			await resolveCommunityReport({
				env: input.env,
				adminUserId,
				reportId: input.reportId,
				action: 'dismiss',
				resolutionNote: note,
			})
		},
		'Unable to resolve report.',
	)
}
export async function delistAdminCommunityReport(input: ReportInput) {
	return moderateReport(
		input,
		async ({ adminUserId, note }) => {
			await resolveCommunityReport({
				env: input.env,
				adminUserId,
				reportId: input.reportId,
				action: 'delist',
				resolutionNote: note,
			})
		},
		'Unable to resolve report.',
	)
}
export async function deleteAdminCommunityReport(input: ReportInput) {
	return moderateReport(
		input,
		async ({ adminUserId, note }) => {
			await resolveCommunityReport({
				env: input.env,
				adminUserId,
				reportId: input.reportId,
				action: 'delete',
				resolutionNote: note,
			})
		},
		'Unable to resolve report.',
	)
}
export async function banAdminReportReporter(input: ReportInput) {
	return moderateReport(
		input,
		async ({ adminUserId, note, report }) => {
			await banCommunityUser({
				env: input.env,
				adminUserId,
				userId: report.reporterUserId,
				reason:
					note ?? `Banned via community report moderation (${report.id}).`,
			})
		},
		'Unable to ban user.',
	)
}
export async function banAdminReportOwner(input: ReportInput) {
	return moderateReport(
		input,
		async ({ adminUserId, note, report }) => {
			await banCommunityUser({
				env: input.env,
				adminUserId,
				userId: report.listingOwnerUserId,
				reason:
					note ?? `Banned via community report moderation (${report.id}).`,
			})
		},
		'Unable to ban user.',
	)
}
