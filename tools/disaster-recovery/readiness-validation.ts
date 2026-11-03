import { isRecord } from '@kody-internal/shared/is-record.ts'

import type { ResourceIdentity } from './readiness-contracts.ts'

export const sha256Pattern = /^[a-f0-9]{64}$/
const isoDatePattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
export const uuidPattern =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
export const base64Pattern =
	/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/
export const cloudflareAccountIdPattern = /^[0-9a-f]{32}$/

export function exactKeys(
	value: Record<string, unknown>,
	expected: ReadonlyArray<string>,
): boolean {
	const actual = Object.keys(value).sort()
	const sortedExpected = [...expected].sort()
	return (
		actual.length === sortedExpected.length &&
		actual.every((key, index) => key === sortedExpected[index])
	)
}

export function isNonemptyString(value: unknown): value is string {
	return typeof value === 'string' && value.trim().length > 0
}

export function isIsoDate(value: unknown): value is string {
	return (
		typeof value === 'string' &&
		isoDatePattern.test(value) &&
		Number.isFinite(Date.parse(value))
	)
}

export function isNonnegativeInteger(value: unknown): value is number {
	return Number.isSafeInteger(value) && Number(value) >= 0
}

export function isPositiveInteger(value: unknown): value is number {
	return Number.isSafeInteger(value) && Number(value) > 0
}

export function parseIdentity(value: unknown): ResourceIdentity | undefined {
	if (
		!isRecord(value) ||
		!exactKeys(value, ['accountId', 'resourceId']) ||
		!isNonemptyString(value.accountId) ||
		!isNonemptyString(value.resourceId)
	) {
		return undefined
	}
	return { accountId: value.accountId, resourceId: value.resourceId }
}

export function identitiesEqual(
	left: ResourceIdentity | null,
	right: ResourceIdentity | null,
): boolean {
	return (
		left === right ||
		(left !== null &&
			right !== null &&
			left.accountId === right.accountId &&
			left.resourceId === right.resourceId)
	)
}
