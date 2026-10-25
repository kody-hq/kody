import { isRecord } from '@kody-internal/shared/is-record.ts'

/**
 * Response field added when a caller still passed leftover `kody_id` /
 * `kodyId` package identity. Callers should switch to `name` / `package_id`
 * (or camelCase `packageId` on endpoints that use that shape) on the next
 * call. Tracked in #3676.
 */
export const kodyIdDeprecationField = 'kody_id_deprecation' as const

function hasNonEmptyString(value: unknown, key: string): boolean {
	if (!isRecord(value)) return false
	const field = value[key]
	return typeof field === 'string' && field.trim().length > 0
}

function leftoverIdentityStyle(args: unknown): 'snake' | 'camel' | null {
	if (!isRecord(args)) return null
	if (hasNonEmptyString(args, 'kodyId')) return 'camel'
	if (hasNonEmptyString(args, 'kody_id')) return 'snake'
	if (isRecord(args['target'])) {
		const target = args['target']
		if (hasNonEmptyString(target, 'kodyId')) return 'camel'
		if (hasNonEmptyString(target, 'kody_id')) return 'snake'
	}
	return null
}

/**
 * True when the capability input used leftover `kody_id` / `kodyId` (top-level
 * or nested under `target`, matching protocol-metrics classification).
 */
export function argsUsedKodyIdPackageIdentity(args: unknown): boolean {
	return leftoverIdentityStyle(args) !== null
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

/**
 * Package identity only. Never treat bare `id` (session ids) or bare `name`
 * on webhook rows (webhook names) as the package.
 */
function identityFromRecord(record: Record<string, unknown>): {
	name?: string
	packageId?: string
} {
	const packageId = readTrimmedString(record, ['package_id', 'packageId'])
	const packageSpecificName = readTrimmedString(record, [
		'package_name',
		'packageName',
		'target_name',
	])
	if (packageSpecificName !== undefined) {
		return { name: packageSpecificName, packageId }
	}
	// Bare `name` is safe on package-shaped records that already carry a
	// package_id / packageId (package summaries, get-git-remote, resolved
	// package targets). Skip it otherwise so webhook `name` is not mistaken.
	if (packageId !== undefined) {
		return {
			name: readTrimmedString(record, ['name']),
			packageId,
		}
	}
	return {}
}

function collectIdentityCandidates(
	result: Record<string, unknown>,
): Array<Record<string, unknown>> {
	const candidates: Array<Record<string, unknown>> = [result]
	for (const key of [
		'package',
		'enablement',
		'resolved_target',
		'webhook',
	] as const) {
		const nested = result[key]
		if (isRecord(nested)) candidates.push(nested)
	}
	const webhooks = result['webhooks']
	if (Array.isArray(webhooks)) {
		for (const entry of webhooks) {
			if (isRecord(entry)) candidates.push(entry)
		}
	}
	return candidates
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
	let name: string | undefined
	let packageId: string | undefined
	for (const candidate of collectIdentityCandidates(result)) {
		const nested = identityFromRecord(candidate)
		name = name ?? nested.name
		packageId = packageId ?? nested.packageId
		if (name !== undefined && packageId !== undefined) break
	}
	return { name, packageId }
}

export function buildKodyIdDeprecationHint(
	result: unknown,
	args?: unknown,
): string {
	const style = leftoverIdentityStyle(args) ?? 'snake'
	const { name, packageId } = resolvePreferredPackageIdentity(result)
	const parts: Array<string> = [
		'Deprecated: the `kody_id` / `kodyId` input is leftover package identity.',
	]
	if (style === 'camel') {
		parts.push(
			'On this call shape prefer `packageId` (the saved-package UUID). Some other capabilities also accept scoped `name`.',
		)
	} else {
		parts.push(
			'Prefer `name` (scoped `@owner/leaf` or the name leaf) or `package_id` (the saved-package UUID). Some camelCase call shapes use `packageId` instead.',
		)
	}
	if (style === 'camel' && packageId !== undefined) {
		parts.push(`For this package use packageId: ${JSON.stringify(packageId)}.`)
	} else if (name !== undefined && packageId !== undefined) {
		parts.push(
			`For this package use name: ${JSON.stringify(name)} or package_id: ${JSON.stringify(packageId)}.`,
		)
	} else if (name !== undefined) {
		parts.push(`For this package use name: ${JSON.stringify(name)}.`)
	} else if (packageId !== undefined) {
		parts.push(
			style === 'camel'
				? `For this package use packageId: ${JSON.stringify(packageId)}.`
				: `For this package use package_id: ${JSON.stringify(packageId)}.`,
		)
	}
	parts.push(
		style === 'camel'
			? 'Stop sending `kodyId` on your next call.'
			: 'Stop sending `kody_id` on your next call.',
	)
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
		[kodyIdDeprecationField]: buildKodyIdDeprecationHint(result, args),
	}
}
