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

function leftoverLeafFromArgs(args: unknown): string | undefined {
	if (!isRecord(args)) return undefined
	for (const key of ['kodyId', 'kody_id'] as const) {
		if (hasNonEmptyString(args, key)) {
			return String(args[key]).trim()
		}
	}
	if (isRecord(args['target'])) {
		const target = args['target']
		for (const key of ['kodyId', 'kody_id'] as const) {
			if (hasNonEmptyString(target, key)) {
				return String(target[key]).trim()
			}
		}
	}
	return undefined
}

function leftoverIdentityStyle(args: unknown): 'snake' | 'camel' | null {
	if (!isRecord(args)) return null
	if (hasNonEmptyString(args, 'kodyId')) return 'camel'
	if (hasNonEmptyString(args, 'kody_id')) return 'snake'
	if (isRecord(args['target'])) {
		const target = args['target']
		// Repo target preprocess rewrites camelCase aliases to snake_case before
		// handlers run, so `kodyId` is already `kody_id` here. Treat package
		// targets as their own hint shape (prefer target.package_id).
		if (
			hasNonEmptyString(target, 'kodyId') ||
			hasNonEmptyString(target, 'kody_id')
		) {
			return 'snake'
		}
	}
	return null
}

function isRepoPackageTargetArgs(args: unknown): boolean {
	return (
		isRecord(args) &&
		isRecord(args['target']) &&
		args['target']['kind'] === 'package' &&
		(hasNonEmptyString(args['target'], 'kody_id') ||
			hasNonEmptyString(args['target'], 'kodyId'))
	)
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

function looksLikeWebhookRecord(record: Record<string, unknown>): boolean {
	return (
		readTrimmedString(record, [
			'package_kody_id',
			'packageKodyId',
			'export_name',
			'exportName',
			'endpoint_id',
			'endpointId',
			'handle',
		]) !== undefined
	)
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
	// package targets). Skip webhook rows: their `name` is the webhook name.
	if (packageId !== undefined && !looksLikeWebhookRecord(record)) {
		return {
			name: readTrimmedString(record, ['name']),
			packageId,
		}
	}
	return { packageId }
}

function leafOfPackageName(value: string): string {
	const trimmed = value.trim()
	const slash = trimmed.lastIndexOf('/')
	return slash === -1 ? trimmed : trimmed.slice(slash + 1)
}

/**
 * Webhook list rows can span multiple packages that share a leftover leaf.
 * Only advertise an identity when every matching row agrees, or when a single
 * row's package_kody_id / package leaf matches the caller's leftover leaf.
 */
function identityFromWebhookList(
	webhooks: ReadonlyArray<unknown>,
	leftoverLeaf: string | undefined,
): { name?: string; packageId?: string } {
	const rows = webhooks.filter(isRecord)
	if (rows.length === 0) return {}

	const matched =
		leftoverLeaf === undefined
			? rows
			: rows.filter((row) => {
					const packageKodyId = readTrimmedString(row, [
						'package_kody_id',
						'packageKodyId',
					])
					const packageName = readTrimmedString(row, [
						'package_name',
						'packageName',
					])
					if (packageKodyId === leftoverLeaf) return true
					if (
						packageName !== undefined &&
						leafOfPackageName(packageName) === leftoverLeaf
					) {
						return true
					}
					return false
				})

	const pool = leftoverLeaf !== undefined && matched.length > 0 ? matched : rows
	const identities = pool.map(identityFromRecord)
	const packageIds = new Set(
		identities
			.map((identity) => identity.packageId)
			.filter((value): value is string => value !== undefined),
	)
	const names = new Set(
		identities
			.map((identity) => identity.name)
			.filter((value): value is string => value !== undefined),
	)
	if (packageIds.size > 1 || names.size > 1) {
		// Ambiguous leftover leaf across packages: teach the switch without a
		// concrete (possibly wrong) package value.
		return {}
	}
	return {
		name: names.size === 1 ? [...names][0] : undefined,
		packageId: packageIds.size === 1 ? [...packageIds][0] : undefined,
	}
}

function collectNonWebhookCandidates(
	result: Record<string, unknown>,
): Array<Record<string, unknown>> {
	const candidates: Array<Record<string, unknown>> = [result]
	for (const key of ['package', 'enablement', 'resolved_target'] as const) {
		const nested = result[key]
		if (isRecord(nested)) candidates.push(nested)
	}
	return candidates
}

/**
 * Prefer scoped `name` and `package_id` from the resolved result so the next
 * call can drop `kody_id` without another lookup.
 */
export function resolvePreferredPackageIdentity(
	result: unknown,
	args?: unknown,
): {
	name?: string
	packageId?: string
} {
	if (!isRecord(result)) return {}
	let name: string | undefined
	let packageId: string | undefined
	for (const candidate of collectNonWebhookCandidates(result)) {
		const nested = identityFromRecord(candidate)
		name = name ?? nested.name
		packageId = packageId ?? nested.packageId
		if (name !== undefined && packageId !== undefined) break
	}
	if (name === undefined || packageId === undefined) {
		const webhookRows: Array<unknown> = []
		if (Array.isArray(result['webhooks'])) {
			webhookRows.push(...result['webhooks'])
		}
		if (isRecord(result['webhook'])) {
			webhookRows.push(result['webhook'])
		}
		if (webhookRows.length > 0) {
			const fromWebhooks = identityFromWebhookList(
				webhookRows,
				leftoverLeafFromArgs(args),
			)
			name = name ?? fromWebhooks.name
			packageId = packageId ?? fromWebhooks.packageId
		}
	}
	return { name, packageId }
}

function isCommunityForkResult(result: unknown): boolean {
	return isRecord(result) && typeof result['fork_id'] === 'string'
}

export function buildKodyIdDeprecationHint(
	result: unknown,
	args?: unknown,
): string {
	const { name, packageId } = resolvePreferredPackageIdentity(result, args)

	// communityFork uses leftover `kody_id` as an optional destination leaf,
	// not as package lookup. It does not accept `name` / `package_id`.
	if (isCommunityForkResult(result)) {
		const parts = [
			'Deprecated: the `kody_id` input on communityFork is a leftover destination-leaf alias.',
			'Omit `kody_id` when the listing leaf (or next free alternate) is fine.',
		]
		if (name !== undefined) {
			parts.push(
				`This fork landed as ${JSON.stringify(name)}${packageId !== undefined ? ` (package_id ${JSON.stringify(packageId)} for later lookup)` : ''}.`,
			)
		} else if (packageId !== undefined) {
			parts.push(
				`This fork package_id is ${JSON.stringify(packageId)} for later lookup.`,
			)
		}
		parts.push('Stop sending `kody_id` on your next communityFork call.')
		return parts.join(' ')
	}

	// Repo package targets normalize camelCase aliases to snake_case before
	// handlers run. Prefer target.package_id; do not suggest bare `name`
	// (that field means a plain repo on other target kinds).
	if (isRepoPackageTargetArgs(args)) {
		const parts = [
			'Deprecated: `target.kody_id` / `target.kodyId` is leftover package identity.',
			'Prefer `target: { kind: "package", package_id }` (the saved-package UUID).',
		]
		if (packageId !== undefined) {
			parts.push(
				`For this package use package_id: ${JSON.stringify(packageId)}.`,
			)
		} else if (name !== undefined) {
			parts.push(
				`Resolved package name was ${JSON.stringify(name)}; look up its package_id for the next call.`,
			)
		}
		parts.push('Stop sending target.kody_id / target.kodyId on your next call.')
		return parts.join(' ')
	}

	const style = leftoverIdentityStyle(args) ?? 'snake'
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
