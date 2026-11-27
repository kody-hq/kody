import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import type { RequestCredential } from '@kody-internal/shared/request-context.ts'

/**
 * The agent credential a visit session acts as: what `appOpenLink` copied
 * from the calling token. `profileOrgId` is always set with `profileId`.
 */
export type AppVisitSessionCredential = Pick<
	RequestCredential,
	'kind' | 'id' | 'scopes'
> & {
	profileId?: string
	profileChain?: ReadonlyArray<string>
	profileOrgId?: OwnerId
}

const isText = (value: unknown): value is string =>
	typeof value === 'string' && value.length > 0

export function isAppVisitSessionCredential(
	value: unknown,
): value is AppVisitSessionCredential {
	if (!value || typeof value !== 'object') return false
	const record = value as Record<string, unknown>
	const hasProfile = record.profileId !== undefined
	return (
		isText(record.kind) &&
		(record.id === null || isText(record.id)) &&
		(record.scopes === null ||
			(Array.isArray(record.scopes) && record.scopes.every(isText))) &&
		(hasProfile
			? isText(record.profileId) &&
				isText(record.profileOrgId) &&
				Array.isArray(record.profileChain) &&
				record.profileChain.every(isText)
			: record.profileChain === undefined && record.profileOrgId === undefined)
	)
}
