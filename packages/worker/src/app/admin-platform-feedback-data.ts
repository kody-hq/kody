import { readPositiveInt } from '#worker/query-params.ts'
import {
	type AdminPlatformFeedbackDetail,
	type AdminPlatformFeedbackListItem,
	type AdminPlatformFeedbackLoaderData,
} from '#universal/loader-data.ts'
import {
	getPlatformFeedbackForAdmin,
	listPlatformFeedbackForAdmin,
} from '#worker/platform-feedback/service.ts'
import {
	platformFeedbackCategories,
	platformFeedbackStatuses,
	type PlatformFeedbackCategory,
	type PlatformFeedbackListItem,
	type PlatformFeedbackRecord,
	type PlatformFeedbackStatus,
} from '#worker/platform-feedback/types.ts'

const defaultPageSize = 20
const maxPageSize = 100
const maxFeedbackIdLength = 1_000

function readStatusFilter(value: string | null): PlatformFeedbackStatus | null {
	return value &&
		(platformFeedbackStatuses as ReadonlyArray<string>).includes(value)
		? (value as PlatformFeedbackStatus)
		: null
}

function readCategoryFilter(
	value: string | null,
): PlatformFeedbackCategory | null {
	return value &&
		(platformFeedbackCategories as ReadonlyArray<string>).includes(value)
		? (value as PlatformFeedbackCategory)
		: null
}

export function readAdminPlatformFeedbackId(value: string | null) {
	const normalized = value?.trim() ?? ''
	return normalized.length > 0 && normalized.length <= maxFeedbackIdLength
		? normalized
		: null
}

function formatListItem(
	feedback: PlatformFeedbackListItem,
): AdminPlatformFeedbackListItem {
	return {
		id: feedback.id,
		submitter_user_id: feedback.submitterUserId,
		category: feedback.category,
		summary_untrusted: feedback.summary,
		status: feedback.status,
		reviewed_by_user_id: feedback.reviewedByUserId,
		reviewed_at: feedback.reviewedAt,
		created_at: feedback.createdAt,
		updated_at: feedback.updatedAt,
	}
}

function formatDetail(
	feedback: PlatformFeedbackRecord,
): AdminPlatformFeedbackDetail {
	return {
		...formatListItem(feedback),
		details_untrusted: feedback.details,
		admin_note: feedback.adminNote,
		resolution_note: feedback.resolutionNote,
		resolution_pr_urls: feedback.resolutionPrUrls,
		submitter: {
			user_id: feedback.submitterUserId,
			username: feedback.submitterUsername,
			email: feedback.submitterEmail,
		},
	}
}

export async function loadAdminPlatformFeedbackData(
	env: Env,
	requestUrl: string,
): Promise<AdminPlatformFeedbackLoaderData> {
	const url = new URL(requestUrl, 'http://localhost')
	const page = readPositiveInt(url.searchParams.get('page'), 1)
	const pageSize = readPositiveInt(
		url.searchParams.get('pageSize'),
		defaultPageSize,
		maxPageSize,
	)
	const statusFilter = readStatusFilter(url.searchParams.get('status'))
	const categoryFilter = readCategoryFilter(url.searchParams.get('category'))
	const feedbackId = readAdminPlatformFeedbackId(
		url.searchParams.get('feedbackId'),
	)
	return readAdminPlatformFeedbackData(env, {
		page,
		pageSize,
		status: statusFilter,
		category: categoryFilter,
		feedbackId,
	})
}
export async function readAdminPlatformFeedbackData(
	env: Env,
	input: {
		page: number
		pageSize: number
		status: string | null
		category: string | null
		feedbackId: string | null
	},
): Promise<AdminPlatformFeedbackLoaderData> {
	const page = Math.max(1, Math.floor(input.page))
	const pageSize = Math.min(
		maxPageSize,
		Math.max(1, Math.floor(input.pageSize)),
	)
	const statusFilter = readStatusFilter(input.status)
	const categoryFilter = readCategoryFilter(input.category)
	const feedbackId = readAdminPlatformFeedbackId(input.feedbackId)
	const [initialList, selectedRecord] = await Promise.all([
		listPlatformFeedbackForAdmin({
			db: env.APP_DB,
			page,
			pageSize,
			status: statusFilter ?? undefined,
			category: categoryFilter ?? undefined,
		}),
		feedbackId
			? getPlatformFeedbackForAdmin({
					db: env.APP_DB,
					feedbackId,
				})
			: Promise.resolve(null),
	])
	let list = initialList
	const lastPage = list.total === 0 ? 1 : Math.ceil(list.total / list.pageSize)
	if (list.page > lastPage) {
		list = await listPlatformFeedbackForAdmin({
			db: env.APP_DB,
			page: lastPage,
			pageSize,
			status: statusFilter ?? undefined,
			category: categoryFilter ?? undefined,
		})
	}

	return {
		ok: true,
		feedback: list.items.map(formatListItem),
		selectedFeedback: selectedRecord ? formatDetail(selectedRecord) : null,
		page: list.page,
		pageSize: list.pageSize,
		total: list.total,
		statusFilter,
		categoryFilter,
	}
}
