import { personIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import type {
	RequestContext,
	RequestLineage,
} from '@kody-internal/shared/request-context.ts'
import {
	deriveRequestContext,
	requestLineage,
} from '#worker/request-context/request-context.ts'

/** The request context a signed-in browser session has for `stableUserId`. */
export function sessionRequestContext(
	stableUserId: string,
	username?: string,
): RequestContext {
	return deriveRequestContext({
		user: {
			userId: personIdFromStored(stableUserId),
			...(username ? { username } : {}),
		},
		source: { kind: 'session' },
	})
}

export function sessionRequestLineage(stableUserId: string): RequestLineage {
	return requestLineage(sessionRequestContext(stableUserId))
}
