import { type RequestContext } from '@kody-internal/shared/request-context.ts'
import {
	AuthorizationError,
	authorizeOrgWide,
} from '#worker/authorization/authorize.ts'

/**
 * Whether the website may show this org's run history (Activity, Overview
 * run summary, charts, and recent runs): the same org-wide `job:read` that
 * `runList` requires. A grant on one job is not enough.
 */
export async function canReadOrgRunHistory(input: {
	env: Env
	request: RequestContext | null
}) {
	try {
		await authorizeOrgWide(input, 'job:read')
		return true
	} catch (error) {
		if (error instanceof AuthorizationError) return false
		throw error
	}
}
