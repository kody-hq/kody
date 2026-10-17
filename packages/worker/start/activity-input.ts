import { readAccountActivityFilters } from '#universal/account-activity-filters.ts'
import { type ActivityInput } from './activity-query.ts'

/** Normalize browser URL filters once, before they become Query keys or RPC inputs. */
export function activityInput(
	orgSlug: string,
	search: string,
	runId?: string,
): ActivityInput {
	const params = new URLSearchParams(search)
	return {
		orgSlug,
		selectedRunId: runId?.trim() || params.get('selected')?.trim() || null,
		...readAccountActivityFilters(`/${search}`),
	}
}
