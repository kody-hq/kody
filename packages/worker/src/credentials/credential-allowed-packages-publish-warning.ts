/**
 * Advance (non-blocking) publish/save warnings when a package fills a
 * user-scope credential by literal name and that credential's allowed-packages
 * list is non-empty and does not include this package. Stricter enforcement of
 * the existing allowed-packages setting starts Wednesday, Oct 21, 2026; until
 * then these warnings only tip owners to approve or move the use.
 *
 * Does not change fill, access, publish, or save behavior.
 */
import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import {
	scanPackageCredentials,
	type PackageCredentialScan,
} from '#worker/credentials/credential-inventory-scan.ts'
import {
	type PackageCredentialKind,
	type PackageCredentialSlot,
	packageCredentialKindValues,
} from '#worker/package-registry/types.ts'
import {
	getSavedPackageById,
	listSavedPackagesByIds,
} from '#worker/package-registry/repo.ts'
import { buildSecretPackageApprovalUrl } from '#mcp/secrets/package-approval-url.ts'
import { resolveSecretPageOrgSlug } from '#mcp/secrets/package-access.ts'
import { findSecret } from '#mcp/secrets/service.ts'
import { normalizeRepoWorkspacePath } from '#worker/repo/manifest.ts'

export const credentialAllowedPackagesEnforcementDate =
	'Wednesday, Oct 21, 2026'

export type AllowedPackagesListEntry =
	| { kind: 'package'; id: string; displayName: string }
	| { kind: 'not-a-package-id'; value: string }

export type CredentialAllowedPackagesPublishWarning = {
	credentialName: string
	allowedEntries: Array<AllowedPackagesListEntry>
	packageDisplayName: string
	approvalUrl: string
}

const packageCredentialKinds: ReadonlySet<string> = new Set(
	packageCredentialKindValues,
)

/**
 * Pure message for one mismatched credential. Never includes credential values.
 */
export function formatCredentialAllowedPackagesPublishWarning(
	input: CredentialAllowedPackagesPublishWarning,
): string {
	const allowedList = formatAllowedPackagesList(input.allowedEntries)
	return `Credential "${input.credentialName}" is allowed only for ${allowedList}, not ${input.packageDisplayName}. Starting ${credentialAllowedPackagesEnforcementDate}, Kody enforces allowed-package lists everywhere, including when this package is used through another package or loaded in a one-off execute run, so these uses will be denied. To allow it, approve: ${input.approvalUrl}. Or move this credential use into a package that is already allowed.`
}

export function formatAllowedPackagesList(
	entries: ReadonlyArray<AllowedPackagesListEntry>,
): string {
	if (entries.length === 0) return '(empty list)'
	return entries
		.map((entry) => {
			switch (entry.kind) {
				case 'package':
					return entry.displayName
				case 'not-a-package-id':
					return `${entry.value} (not a package id; fix the list)`
				default: {
					const exhaustive: never = entry
					throw new Error(`Unhandled allowed list entry: ${String(exhaustive)}`)
				}
			}
		})
		.join(', ')
}

export function formatCredentialAllowedPackagesPublishWarnings(
	warnings: ReadonlyArray<CredentialAllowedPackagesPublishWarning>,
): string | null {
	if (warnings.length === 0) return null
	return warnings
		.map(formatCredentialAllowedPackagesPublishWarning)
		.join('\n\n')
}

/**
 * Literal user-scope secret names the package fills (placeholders, secret
 * slots, and secretJwtSign names). Computed names are not in the scan
 * references and are skipped silently.
 */
export function collectLiteralUserSecretNames(
	scan: PackageCredentialScan,
): Array<string> {
	const names = new Set<string>()
	for (const reference of scan.references) {
		if (reference.nameKind !== 'secret') continue
		if (reference.scope === 'package' || reference.scope === 'session') continue
		names.add(reference.name)
	}
	for (const slot of scan.slots) {
		if (slot.kind === 'secret') names.add(slot.name)
	}
	for (const name of scan.jwtSignSecretNames) {
		names.add(name)
	}
	return [...names].sort((left, right) => left.localeCompare(right))
}

export function resolveAllowedPackagesListEntries(input: {
	allowedPackages: ReadonlyArray<string>
	packagesById: ReadonlyMap<
		string,
		{ id: string; name: string; kodyId: string }
	>
}): Array<AllowedPackagesListEntry> {
	return input.allowedPackages.map((value) => {
		const saved = input.packagesById.get(value)
		if (saved) {
			return {
				kind: 'package' as const,
				id: saved.id,
				displayName: saved.name || saved.kodyId || saved.id,
			}
		}
		return { kind: 'not-a-package-id' as const, value }
	})
}

/**
 * Non-blocking publish/save notice when this package fills user credentials
 * whose allowed-packages list excludes it. Null when there is nothing to warn
 * about (empty list, package already allowed, or no attributable fills).
 */
export async function buildCredentialAllowedPackagesPublishWarningNotice(input: {
	env: Pick<Env, 'APP_DB' | 'SECRET_STORE_KEY'>
	baseUrl: string
	userId: OwnerId
	orgSlug?: string | null
	packageId: string
	packageDisplayName: string
	kodyId: string
	files: Record<string, string>
	sourceRoot?: string | null
	slots?: Record<string, PackageCredentialSlot> | undefined
}): Promise<string | null> {
	try {
		const warnings = await buildCredentialAllowedPackagesPublishWarnings(input)
		return formatCredentialAllowedPackagesPublishWarnings(warnings)
	} catch {
		// Non-blocking: any warning failure leaves the save/publish result unchanged.
		return null
	}
}

/**
 * Resolve the saved package then build the notice. Swallows lookup/scan
 * failures so stub APP_DB in unit tests and transient D1 errors never fail
 * publish or save.
 */
export async function loadCredentialAllowedPackagesPublishWarningNotice(input: {
	env: Pick<Env, 'APP_DB' | 'SECRET_STORE_KEY'>
	baseUrl: string
	userId: OwnerId
	orgSlug?: string | null
	packageId: string
	files: Record<string, string>
	sourceRoot?: string | null
	slots?: Record<string, PackageCredentialSlot> | undefined
}): Promise<string | null> {
	try {
		const savedPackage = await getSavedPackageById(input.env.APP_DB, {
			userId: input.userId,
			packageId: input.packageId,
		})
		if (!savedPackage) return null
		return await buildCredentialAllowedPackagesPublishWarningNotice({
			env: input.env,
			baseUrl: input.baseUrl,
			userId: input.userId,
			orgSlug: input.orgSlug,
			packageId: savedPackage.id,
			packageDisplayName: savedPackage.name,
			kodyId: savedPackage.kodyId,
			files: input.files,
			sourceRoot: input.sourceRoot,
			slots: input.slots,
		})
	} catch {
		return null
	}
}

/**
 * Scope a repo-rooted file map to the package source root.
 *
 * Contract: pass `sourceRoot` only when `files` is keyed from the repo root.
 * With a non-empty root this returns only paths under `root/` (stripped), or
 * `{}` when none match — never falls back to the unscoped map. Already
 * package-relative trees must omit `sourceRoot` (same as
 * `credentialPatternNoticeForFiles(files)` without a root).
 */
export function filesForPackageSourceRoot(
	files: Record<string, string>,
	sourceRoot?: string | null,
): Record<string, string> {
	const root = normalizeRepoWorkspacePath(sourceRoot ?? '')
		.replace(/^(?:\.\/)+/, '')
		.replace(/\/+$/, '')
	if (!root || root === '.') return files
	return Object.fromEntries(
		Object.entries(files)
			.filter(([path]) => path.startsWith(`${root}/`))
			.map(([path, content]) => [path.slice(root.length + 1), content]),
	)
}

export async function buildCredentialAllowedPackagesPublishWarnings(input: {
	env: Pick<Env, 'APP_DB' | 'SECRET_STORE_KEY'>
	baseUrl: string
	userId: OwnerId
	orgSlug?: string | null
	packageId: string
	packageDisplayName: string
	kodyId: string
	files: Record<string, string>
	sourceRoot?: string | null
	slots?: Record<string, PackageCredentialSlot> | undefined
}): Promise<Array<CredentialAllowedPackagesPublishWarning>> {
	try {
		const scopedFiles = filesForPackageSourceRoot(input.files, input.sourceRoot)
		let scan: PackageCredentialScan
		try {
			scan = scanPackageCredentials({
				files: scopedFiles,
				slots:
					input.slots ??
					readDeclaredCredentialSlots(scopedFiles['package.json']),
			})
		} catch {
			return []
		}
		const secretNames = collectLiteralUserSecretNames(scan)
		if (secretNames.length === 0) return []

		const storageContext = {
			sessionId: null,
			appId: null,
			packageId: input.packageId,
			storageId: null,
		}
		const mismatched: Array<{
			name: string
			allowedPackages: Array<string>
		}> = []
		for (const name of secretNames) {
			const found = await findSecret({
				env: input.env,
				userId: input.userId,
				name,
				scope: 'user',
				storageContext,
			})
			if (!found.found || found.scope !== 'user') continue
			if (found.allowedPackages.length === 0) continue
			if (found.allowedPackages.includes(input.packageId)) continue
			mismatched.push({ name, allowedPackages: found.allowedPackages })
		}
		if (mismatched.length === 0) return []

		const allowedIds = [
			...new Set(mismatched.flatMap((entry) => entry.allowedPackages)),
		]
		const packages = await listSavedPackagesByIds(input.env.APP_DB, {
			userId: input.userId,
			packageIds: allowedIds,
		})
		const packagesById = new Map(
			packages.map((saved) => [
				saved.id,
				{ id: saved.id, name: saved.name, kodyId: saved.kodyId },
			]),
		)

		const orgSlug = await resolveSecretPageOrgSlug({
			db: input.env.APP_DB,
			userId: input.userId,
			orgSlug: input.orgSlug,
		})
		if (!orgSlug) return []

		return mismatched.map((entry) => ({
			credentialName: entry.name,
			allowedEntries: resolveAllowedPackagesListEntries({
				allowedPackages: entry.allowedPackages,
				packagesById,
			}),
			packageDisplayName: input.packageDisplayName,
			approvalUrl: buildSecretPackageApprovalUrl({
				baseUrl: input.baseUrl,
				orgSlug,
				name: entry.name,
				scope: 'user',
				packageId: input.packageId,
				kodyId: input.kodyId,
				storageContext,
			}),
		}))
	} catch {
		return []
	}
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value != null && typeof value === 'object' && !Array.isArray(value)
}

function isPackageCredentialKind(
	value: string,
): value is PackageCredentialKind {
	return packageCredentialKinds.has(value)
}

function readDeclaredCredentialSlots(
	manifestSource: string | undefined,
): Record<string, PackageCredentialSlot> | undefined {
	if (manifestSource == null) return undefined
	let parsed: unknown
	try {
		parsed = JSON.parse(manifestSource)
	} catch {
		return undefined
	}
	if (!isPlainObject(parsed) || !isPlainObject(parsed.kody)) return undefined
	const credentials = parsed.kody.credentials
	if (!isPlainObject(credentials)) return undefined
	const slots: Record<string, PackageCredentialSlot> = {}
	for (const [name, slot] of Object.entries(credentials)) {
		const declared = credentialSlotFromManifest(slot)
		if (declared) slots[name] = declared
	}
	return Object.keys(slots).length > 0 ? slots : undefined
}

function credentialSlotFromManifest(
	slot: unknown,
): PackageCredentialSlot | null {
	if (!isPlainObject(slot)) return null
	const description =
		typeof slot.description === 'string' && slot.description.trim().length > 0
			? slot.description
			: null
	if (description == null) return null
	const declared: PackageCredentialSlot = { description }
	if (typeof slot.kind === 'string') {
		if (!isPackageCredentialKind(slot.kind)) return null
		declared.kind = slot.kind
	}
	if (typeof slot.provider === 'string' && slot.provider.trim().length > 0) {
		declared.provider = slot.provider
	}
	if (typeof slot.multiple === 'boolean') declared.multiple = slot.multiple
	return declared
}
