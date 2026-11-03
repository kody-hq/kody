import { getSavedPackageByName } from '#worker/package-registry/repo.ts'
import type { SavedPackageRecord } from '#worker/package-registry/types.ts'
import {
	checkPermission,
	getRequestPermissions,
	packageResource,
} from '#worker/authorization/authorize.ts'

export const packageSpecifierPrefix = 'kody:@'

/**
 * Caller referenced a `kody:@scope/pkg` import that is not saved in this org.
 * Observability treats it like `PackageNameInputError` and keeps it off
 * Sentry (KODY-86).
 */
export class SavedPackageNotFoundError extends Error {
	constructor(packageName: string) {
		super(
			`Saved package "${packageName}" was not found in this org. Imports resolve only within the caller's org; to use a package from another org, communityFork it into this org and import the copy.`,
		)
		this.name = 'SavedPackageNotFoundError'
	}
}

export type KodyPackageSpecifier = {
	packageName: string
	exportName: string
}

/**
 * Resolution result for a `kody:@scope/name` import. Imports resolve only
 * from the caller's own org: a package from another org must be
 * `communityFork`ed first (no cross-org execution).
 */
export type ResolvedPackageImport = {
	row: SavedPackageRecord
}

function unsupportedSpecifierError(specifier: string) {
	return new Error(`Unsupported Kody package specifier "${specifier}".`)
}

export function parseKodyPackageSpecifier(
	specifier: string,
): KodyPackageSpecifier {
	if (!specifier.startsWith(packageSpecifierPrefix)) {
		throw unsupportedSpecifierError(specifier)
	}

	const trimmed = specifier.slice(packageSpecifierPrefix.length).trim()
	if (!trimmed) {
		throw unsupportedSpecifierError(specifier)
	}

	const segments = trimmed.split('/').map((segment) => segment.trim())
	if (segments.length < 2 || segments[0] === '' || segments[1] === '') {
		throw unsupportedSpecifierError(specifier)
	}

	const scope = segments[0]
	const packageLeaf = segments[1]
	if (!scope || !packageLeaf) {
		throw unsupportedSpecifierError(specifier)
	}

	const packageName = `@${scope}/${packageLeaf}`
	const exportName = segments.slice(2).join('/').trim() || '.'

	return {
		packageName,
		exportName,
	}
}

export async function resolveSavedPackageImport(input: {
	db: D1Database
	userId: string
	specifier: string | KodyPackageSpecifier
}): Promise<ResolvedPackageImport | null> {
	const parsed =
		typeof input.specifier === 'string'
			? parseKodyPackageSpecifier(input.specifier)
			: input.specifier
	const own = await getSavedPackageByName(input.db, {
		userId: input.userId,
		name: parsed.packageName,
	})
	if (!own) return null
	const access = getRequestPermissions()
	// Outside a request binding (jobs, apps, nested runtimes) → allow.
	if (!access) return { row: own }
	const decision = checkPermission(
		access,
		'package:execute',
		packageResource({ id: own.id, userId: own.userId, label: own.name }),
	)
	if (decision.allowed) return { row: own }
	// A package under another org's storage stays "not found". A credential
	// scope denial must name the missing scope (CLI package-graph needs it).
	if (decision.error.code === 'wrong_org') return null
	throw decision.error
}
