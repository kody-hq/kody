import { packageJobIdPrefix } from '@kody-internal/shared/jobs/package-job-id.ts'
import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { isSecretExpired } from '@kody-internal/shared/secret-expires-at.ts'
import { type StorageContext } from '#mcp/storage.ts'
import { getOrgById } from '#worker/orgs/repo.ts'
import { getSavedPackageById } from '#worker/package-registry/repo.ts'
import {
	isPackageOwnedStorageId,
	packageIdFromCanonicalPackageStorageId,
} from '#worker/storage-ids.ts'
import {
	createMissingSecretMessage,
	createSecretScopeUnavailableMessage,
	type SecretScopeMissingPackageContext,
	type SecretScopeUnavailableMatch,
} from './errors.ts'
import { isReservedSecretName } from './name-guards.ts'
import { buildSecretEditorUrl } from './package-approval-url.ts'
import { listSecretLocationsByNameForUser } from './repo.ts'
import { getSecretBindingKey } from './secret-bindings.ts'
import { type SecretScope } from './types.ts'

const inaccessibleScopeRank: Record<SecretScope, number> = {
	package: 0,
	session: 1,
	user: 2,
}

export async function createUnresolvedSecretMessage(input: {
	env: Pick<Env, 'APP_DB'>
	userId: string
	name: string
	scope?: SecretScope | null
	storageContext?: StorageContext | null
	baseUrl: string
}) {
	const secretName = input.name.trim()
	if (!secretName) return createMissingSecretMessage(input.name)
	if (!input.env.APP_DB) return createMissingSecretMessage(secretName)
	try {
		const matches = await listInaccessibleSecretMatches({
			env: input.env,
			userId: input.userId,
			name: secretName,
			requestedScope: input.scope ?? null,
			storageContext: input.storageContext ?? null,
			baseUrl: input.baseUrl,
		})
		if (matches.length === 0) return createMissingSecretMessage(secretName)
		return createSecretScopeUnavailableMessage(matches)
	} catch {
		return createMissingSecretMessage(secretName)
	}
}

async function listInaccessibleSecretMatches(input: {
	env: Pick<Env, 'APP_DB'>
	userId: string
	name: string
	requestedScope: SecretScope | null
	storageContext: StorageContext | null
	baseUrl: string
}): Promise<Array<SecretScopeUnavailableMatch>> {
	if (isReservedSecretName(input.name)) return []
	const locations = await listSecretLocationsByNameForUser({
		db: input.env.APP_DB,
		userId: input.userId,
		name: input.name,
	})
	const inaccessible = locations.filter((location) => {
		if (isSecretExpired(location.expires_at)) return false
		return !isSecretVisibleToLookup({
			scope: location.scope,
			bindingKey: location.binding_key,
			requestedScope: input.requestedScope,
			storageContext: input.storageContext,
		})
	})
	if (inaccessible.length === 0) return []

	const packageIds = [
		...new Set(
			inaccessible
				.filter((location) => location.scope === 'package')
				.map((location) => location.binding_key)
				.filter((packageId) => packageId.length > 0),
		),
	]
	const orgSlug = await getOrgById(
		input.env.APP_DB,
		ownerIdFromStored(input.userId),
	).then(
		(org) => org?.slug.trim() || null,
		() => null,
	)
	const packageNames = new Map<string, string>()
	const packageUpdatedAt = new Map<string, string>()
	await Promise.all(
		packageIds.map(async (packageId) => {
			try {
				const savedPackage = await getSavedPackageById(input.env.APP_DB, {
					userId: input.userId,
					packageId,
				})
				if (savedPackage?.kodyId) {
					packageNames.set(packageId, savedPackage.kodyId)
				}
				if (savedPackage?.updatedAt) {
					packageUpdatedAt.set(packageId, savedPackage.updatedAt)
				}
			} catch {
				// Keep the package id in the error when the title lookup fails.
			}
		}),
	)

	return inaccessible
		.map((location) => {
			const packageId =
				location.scope === 'package' ? location.binding_key : null
			const sessionId =
				location.scope === 'session' ? location.binding_key : null
			const missingPackageContext =
				packageId == null
					? null
					: resolveMissingPackageContext({
							secretPackageId: packageId,
							requestedScope: input.requestedScope,
							storageContext: input.storageContext,
							contextSavedAt: packageUpdatedAt.get(packageId) ?? null,
						})
			return {
				secretName: input.name,
				scope: location.scope,
				packageId,
				packageName: packageId ? (packageNames.get(packageId) ?? null) : null,
				sessionId,
				editorUrl: missingPackageContext
					? null
					: buildSecretScopeEditorUrl({
							baseUrl: input.baseUrl,
							orgSlug,
							name: input.name,
							scope: location.scope,
							packageId,
							sessionId,
						}),
				missingPackageContext,
			}
		})
		.sort((left, right) => {
			const rankDelta =
				inaccessibleScopeRank[left.scope] - inaccessibleScopeRank[right.scope]
			if (rankDelta !== 0) return rankDelta
			return (left.packageId ?? left.sessionId ?? '').localeCompare(
				right.packageId ?? right.sessionId ?? '',
			)
		})
}

/**
 * The storage bucket still belongs to the secret's package (job/app/webhook),
 * but `packageId` on the runtime is missing or wrong — so package-scoped
 * secrets cannot bind. Widening scope is the wrong fix.
 */
function resolveMissingPackageContext(input: {
	secretPackageId: string
	requestedScope: SecretScope | null
	storageContext: StorageContext | null
	contextSavedAt: string | null
}): SecretScopeMissingPackageContext | null {
	// A pinned non-package scope hides the secret regardless of package context.
	if (input.requestedScope && input.requestedScope !== 'package') return null
	const storageId = input.storageContext?.storageId?.trim() || null
	if (!storageId) return null
	if (
		!isPackageOwnedStorageId({
			packageId: input.secretPackageId,
			storageId,
		})
	) {
		return null
	}
	const runtimePackageId = input.storageContext?.packageId?.trim() || null
	if (runtimePackageId === input.secretPackageId) {
		// Visible binding should have matched; do not classify as missing.
		return null
	}
	return {
		kind: 'missing_package_context',
		runtimeLabel: describeOwnedPackageRuntime(storageId),
		contextSavedAt: input.contextSavedAt,
	}
}

function describeOwnedPackageRuntime(storageId: string): string {
	if (storageId.startsWith('job:')) {
		const jobId = storageId.slice('job:'.length)
		const jobName = jobNameFromPackageJobId(jobId)
		if (jobName) return `job "${jobName}"`
		return `job runtime "${jobId}"`
	}
	if (packageIdFromCanonicalPackageStorageId(storageId)) {
		return 'the package app runtime'
	}
	return `runtime "${storageId}"`
}

function jobNameFromPackageJobId(jobId: string): string | null {
	if (!jobId.startsWith(packageJobIdPrefix)) return null
	const rest = jobId.slice(packageJobIdPrefix.length)
	const separatorIndex = rest.indexOf(':')
	if (separatorIndex <= 0) return null
	const encodedName = rest.slice(separatorIndex + 1)
	if (!encodedName) return null
	try {
		return decodeURIComponent(encodedName)
	} catch {
		return encodedName
	}
}

function isSecretVisibleToLookup(input: {
	scope: SecretScope
	bindingKey: string
	requestedScope: SecretScope | null
	storageContext: StorageContext | null
}) {
	if (input.requestedScope && input.requestedScope !== input.scope) {
		return false
	}
	const currentBinding = getSecretBindingKey(input.scope, input.storageContext)
	return currentBinding != null && currentBinding === input.bindingKey
}

function buildSecretScopeEditorUrl(input: {
	baseUrl: string
	orgSlug: string | null
	name: string
	scope: SecretScope
	packageId: string | null
	sessionId: string | null
}) {
	if (!input.orgSlug) return null
	try {
		return buildSecretEditorUrl({
			baseUrl: input.baseUrl,
			orgSlug: input.orgSlug,
			name: input.name,
			scope: input.scope,
			packageId: input.packageId,
			sessionId: input.sessionId,
		})
	} catch {
		return null
	}
}
