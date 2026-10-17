import { createListDetailLinks } from '#client/list-detail-route.ts'
import { formatIntegerNumber } from '#client/charts/chart-theme.ts'
import { isUnlimitedLimit } from '#universal/plans.ts'

import { type AdminUserVerificationFilter } from '#universal/email-verification-delivery.ts'

const { buildDetailHref } = createListDetailLinks('/admin/users')

export function formatUsageLimit(limit: number) {
	return isUnlimitedLimit(limit) ? 'Unlimited' : formatIntegerNumber(limit)
}

export function formatUsagePercent(value: number | null) {
	if (value === null) return '—'
	return `${Math.round(value * 100)}%`
}

export type AdminUserFilterState = {
	search: string
	role: string
	verification: AdminUserVerificationFilter | ''
}

export function buildUserDetailHrefFrom(
	currentHref: string,
	stableUserId: string,
) {
	const url = new URL(currentHref, 'http://localhost')
	url.searchParams.delete('page')
	return buildDetailHref(stableUserId, url.search)
}
