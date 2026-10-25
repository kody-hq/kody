import { isRecord } from '@kody-internal/shared/is-record.ts'

/**
 * Response field added when a caller still passed leftover `kody_id` /
 * `kodyId` package identity. Callers should switch to `name` or `package_id`
 * on the next call. Tracked in #3676.
 */
export const kodyIdDeprecationField = 'kody_id_deprecation' as const

function hasNonEmptyString(value: unknown, key: string): boolean {
	if (!isRecord(value)) return false
	const field = value[key]
	return typeof field === 'string' && field.trim().length > 0
}

/**
 * True when the capability input used leftover `kody_id` / `kodyId` (top-level
 * or nested under `target`, matching protocol-metrics classification).
 */
export function argsUsedKodyIdPackageIdentity(args: unknown): boolean {
	if (!isRecord(args)) return false
	if (hasNonEmptyString(args, 'kody_id') || hasNonEmptyString(args, 'kodyId')) {
		return true
	}
	if (isRecord(args['target'])) {
		const target = args['target']
		if (
			hasNonEmptyString(target, 'kody_id') ||
			hasNonEmptyString(target, 'kodyId')
		) {
			return true
		}
	}
	return false
}

function readTrimmedString(
	record: Record<string, unknown>,
	keys: ReadonlyArray<string>,
): string | undefined {
	for (const key of keys) {
		const value = record[key]
		if (typeof value === 'string' && value.trim().length > 0) {
			return value.trim()
		}
	}
	return undefined
}

function identityFromRecord(record: Record<string, unknown>): {
	name?: string
	packageId?: string
} {
	return {
		name: readTrimmedString(record, [
			'name',
			'target_name',
			'package_name',
			'packageName',
		]),
		packageId: readTrimmedString(record, ['package_id', 'packageId', 'id']),
	}
}

/**
 * Prefer scoped `name` and `package_id` from the resolved result so the next
 * call can drop `kody_id` without another lookup.
 */
export function resolvePreferredPackageIdentity(result: unknown): {
	name?: string
	packageId?: string
} {
	if (!isRecord(result)) return {}
	const top = identityFromRecord(result)
	const nestedCandidates: Array<unknown> = [
		result['package'],
		result['enablement'],
	]
	const webhooks = result['webhooks']
	if (Array.isArray(webhooks) && webhooks.length > 0) {
		nestedCandidates.push(webhooks[0])
	}
	let name = top.name
	let packageId = top.packageId
	for (const candidate of nestedCandidates) {
		if (!isRecord(candidate)) continue
		const nested = identityFromRecord(candidate)
		name = name ?? nested.name
		packageId = packageId ?? nested.packageId
	}
	return { name, packageId }
}

export function buildKodyIdDeprecationHint(result: unknown): string {
	const { name, packageId } = resolvePreferredPackageIdentity(result)
	const parts = [
		'Deprecated: the `kody_id` input is leftover package identity.',
		'Prefer `name` (scoped `@owner/leaf` or the name leaf) or `package_id` (the saved-package UUID).',
	]
	if (name !== undefined && packageId !== undefined) {
		parts.push(
			`For this package use name: ${JSON.stringify(name)} or package_id: ${JSON.stringify(packageId)}.`,
		)
	} else if (name !== undefined) {
		parts.push(`For this package use name: ${JSON.stringify(name)}.`)
	} else if (packageId !== undefined) {
		parts.push(`For this package use package_id: ${JSON.stringify(packageId)}.`)
	}
	parts.push('Stop sending `kody_id` on your next call.')
	return parts.join(' ')
}

/**
 * When the caller used leftover `kody_id`, attach a clear deprecation hint to
 * object results. Non-objects are returned unchanged (behavior preserved).
 */
export function attachKodyIdDeprecationHint(
	args: unknown,
	result: unknown,
): unknown {
	if (!argsUsedKodyIdPackageIdentity(args)) return result
	if (!isRecord(result)) return result
	if (typeof result[kodyIdDeprecationField] === 'string') return result
	return {
		...result,
		[kodyIdDeprecationField]: buildKodyIdDeprecationHint(result),
	}
}
