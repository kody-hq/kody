/**
 * URL contract for `/account/activity`: view, status, surface, and triage.
 * Client and server parse the same query so defaults cannot drift.
 */

/** Activity summary / default list window. Waiting uses the same bound. */
export const accountActivitySummaryWindowMs = 7 * 24 * 60 * 60 * 1000

const accountActivityViewFilterValues = ['errors', 'recent'] as const

export type AccountActivityViewFilter =
	(typeof accountActivityViewFilterValues)[number]

const accountActivityStatusFilterValues = [
	'error',
	'all',
	'success',
	'running',
] as const

export type AccountActivityStatusFilter =
	(typeof accountActivityStatusFilterValues)[number]

const accountActivitySurfaceFilterValues = [
	'all',
	'execute',
	'export',
	'subscription',
	'app_fetch',
	'app_realtime',
	'job',
	'workflow',
	'webhook',
] as const

export type AccountActivitySurfaceFilter =
	(typeof accountActivitySurfaceFilterValues)[number]

const accountActivityTriageFilterValues = [
	'open',
	'ignored',
	'resolved',
	'all',
] as const

export type AccountActivityTriageFilter =
	(typeof accountActivityTriageFilterValues)[number]

function isAccountActivityViewFilter(
	value: string | null | undefined,
): value is AccountActivityViewFilter {
	return (
		typeof value === 'string' &&
		(accountActivityViewFilterValues as ReadonlyArray<string>).includes(value)
	)
}

function isAccountActivityStatusFilter(
	value: string | null | undefined,
): value is AccountActivityStatusFilter {
	return (
		typeof value === 'string' &&
		(accountActivityStatusFilterValues as ReadonlyArray<string>).includes(value)
	)
}

function isAccountActivitySurfaceFilter(
	value: string | null | undefined,
): value is AccountActivitySurfaceFilter {
	return (
		typeof value === 'string' &&
		(accountActivitySurfaceFilterValues as ReadonlyArray<string>).includes(
			value,
		)
	)
}

function isAccountActivityTriageFilter(
	value: string | null | undefined,
): value is AccountActivityTriageFilter {
	return (
		typeof value === 'string' &&
		(accountActivityTriageFilterValues as ReadonlyArray<string>).includes(value)
	)
}

export function defaultAccountActivityStatusFilter(
	view: AccountActivityViewFilter,
): AccountActivityStatusFilter {
	switch (view) {
		case 'errors':
			return 'error'
		case 'recent':
			return 'all'
		default: {
			const exhaustive: never = view
			return exhaustive
		}
	}
}

export function defaultAccountActivityTriageFilter(
	view: AccountActivityViewFilter,
): AccountActivityTriageFilter {
	switch (view) {
		case 'errors':
			return 'open'
		case 'recent':
			return 'all'
		default: {
			const exhaustive: never = view
			return exhaustive
		}
	}
}

function searchParamsFromHref(href: string) {
	return new URL(href, 'http://localhost').searchParams
}

export function readAccountActivityViewFilter(
	href: string,
): AccountActivityViewFilter {
	const value = searchParamsFromHref(href).get('view')?.trim()
	return isAccountActivityViewFilter(value) ? value : 'errors'
}

export function readAccountActivityStatusFilter(
	href: string,
): AccountActivityStatusFilter {
	const value = searchParamsFromHref(href).get('status')?.trim()
	if (isAccountActivityStatusFilter(value)) return value
	return defaultAccountActivityStatusFilter(readAccountActivityViewFilter(href))
}

export function readAccountActivitySurfaceFilter(
	href: string,
): AccountActivitySurfaceFilter {
	const value = searchParamsFromHref(href).get('surface')?.trim()
	return isAccountActivitySurfaceFilter(value) ? value : 'all'
}

export function readAccountActivityTriageFilter(
	href: string,
): AccountActivityTriageFilter {
	const params = searchParamsFromHref(href)
	const value =
		params.get('error_triage')?.trim() ?? params.get('triage')?.trim()
	if (isAccountActivityTriageFilter(value)) return value
	return defaultAccountActivityTriageFilter(readAccountActivityViewFilter(href))
}

export function readAccountActivityFilters(requestUrl: string) {
	const url = new URL(requestUrl, 'http://localhost')
	const href = `${url.pathname}${url.search}`
	return {
		viewFilter: readAccountActivityViewFilter(href),
		statusFilter: readAccountActivityStatusFilter(href),
		surfaceFilter: readAccountActivitySurfaceFilter(href),
		triageFilter: readAccountActivityTriageFilter(href),
		cursor: url.searchParams.get('cursor')?.trim() || null,
	}
}

export function buildActivitySearch(input: {
	view: AccountActivityViewFilter
	status: AccountActivityStatusFilter
	surface: AccountActivitySurfaceFilter
	triage: AccountActivityTriageFilter
}) {
	const params = new URLSearchParams()
	if (input.view !== 'errors') params.set('view', input.view)
	if (input.status !== defaultAccountActivityStatusFilter(input.view)) {
		params.set('status', input.status)
	}
	if (input.surface !== 'all') params.set('surface', input.surface)
	if (input.triage !== defaultAccountActivityTriageFilter(input.view)) {
		params.set('error_triage', input.triage)
	}
	const search = params.toString()
	return search ? `?${search}` : ''
}

export function statusFilterToRunStatus(
	filter: AccountActivityStatusFilter,
): 'error' | 'success' | 'running' | null {
	switch (filter) {
		case 'error':
			return 'error'
		case 'success':
			return 'success'
		case 'running':
			return 'running'
		case 'all':
			return null
		default: {
			const exhaustive: never = filter
			return exhaustive
		}
	}
}

export function surfaceFilterToRunSurface(
	filter: AccountActivitySurfaceFilter,
): Exclude<AccountActivitySurfaceFilter, 'all'> | null {
	if (filter === 'all') return null
	return filter
}

export function activityEmptyLabel(input: {
	view: AccountActivityViewFilter
	status: AccountActivityStatusFilter
	surface: AccountActivitySurfaceFilter
	triage: AccountActivityTriageFilter
	summaryTotal: number
}) {
	const defaultsForView =
		input.status === defaultAccountActivityStatusFilter(input.view) &&
		input.surface === 'all' &&
		input.triage === defaultAccountActivityTriageFilter(input.view)
	if (!defaultsForView) return 'No runs match the current filters.'
	switch (input.view) {
		case 'errors':
			if (input.summaryTotal > 0) {
				return 'No open failures in the last 7 days. Switch to Recent runs to see what ran.'
			}
			return 'No failures in the last 7 days. That is good news — when something breaks, it will show up here with its logs.'
		case 'recent':
			return 'Nothing ran in the last 7 days.'
		default: {
			const exhaustive: never = input.view
			return exhaustive
		}
	}
}
