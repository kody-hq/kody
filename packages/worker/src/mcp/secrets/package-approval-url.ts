import {
	buildAccountSecretPath,
	joinOriginAndEncodedPath,
} from '@kody-internal/shared/account-secret-route.ts'
import { orgResourcePathForAccountPath } from '#universal/org-pages.ts'
import type { StorageContext } from '#mcp/storage.ts'
import type { SecretScope } from './types.ts'

const accountSecretsApprovePath = '/account/secrets/approve'
export const maxBulkPackageSecretApprovalNames = 40
const secretNamePattern = /^[a-zA-Z0-9._-]+$/

export function secretPageOrgSlugFromCaller(caller: {
	request?: { org?: { slug?: string | null } | null } | null
	user?: { username?: string } | null
}) {
	return caller.request?.org?.slug?.trim() || null
}

function toOrgSecretPageUrl(input: {
	baseUrl: string
	accountPath: string
	orgSlug: string
	search?: string
}) {
	const orgPath = orgResourcePathForAccountPath(
		input.accountPath,
		input.orgSlug,
	)
	if (!orgPath) {
		throw new Error(
			`Cannot build a secrets page URL for org slug "${input.orgSlug}".`,
		)
	}
	const absolute = joinOriginAndEncodedPath(input.baseUrl, orgPath)
	return input.search ? `${absolute}?${input.search}` : absolute
}

export function buildSecretPackageApprovalUrl(input: {
	baseUrl: string
	orgSlug: string
	name: string
	scope: SecretScope
	packageId: string
	kodyId: string | null
	storageContext: StorageContext | null
}) {
	if (input.scope === 'package' && !input.storageContext?.packageId) {
		throw new Error(
			'storageContext.packageId is required for package-scope approvals.',
		)
	}
	if (input.scope === 'session' && !input.storageContext?.sessionId) {
		throw new Error(
			'storageContext.sessionId is required for session-scope approvals.',
		)
	}
	const secretPath = buildAccountSecretPath({
		name: input.name,
		scope: input.scope,
		packageId: input.storageContext?.packageId ?? null,
		sessionId: input.storageContext?.sessionId ?? null,
	})
	const search = new URLSearchParams()
	search.set('package_id', input.packageId)
	if (input.kodyId) {
		search.set('package', input.kodyId)
	}
	return toOrgSecretPageUrl({
		baseUrl: input.baseUrl,
		accountPath: secretPath,
		orgSlug: input.orgSlug,
		search: search.toString(),
	})
}

export function buildSecretUsageUrl(input: {
	baseUrl: string
	orgSlug: string
	name: string
}) {
	return toOrgSecretPageUrl({
		baseUrl: input.baseUrl,
		accountPath: buildAccountSecretPath({
			name: input.name,
			scope: 'user',
		}),
		orgSlug: input.orgSlug,
	})
}

/** The org secrets page for one stored secret, in any scope. */
export function buildSecretEditorUrl(input: {
	baseUrl: string
	orgSlug: string
	name: string
	scope: SecretScope
	packageId: string | null
	sessionId: string | null
}) {
	return toOrgSecretPageUrl({
		baseUrl: input.baseUrl,
		accountPath: buildAccountSecretPath({
			name: input.name,
			scope: input.scope,
			packageId: input.packageId,
			sessionId: input.sessionId,
		}),
		orgSlug: input.orgSlug,
	})
}

export function normalizeBulkPackageSecretApprovalNames(names: Array<string>) {
	const normalized: Array<string> = []
	const seen = new Set<string>()
	for (const rawName of names) {
		const name = rawName.trim()
		if (!name || !secretNamePattern.test(name) || seen.has(name)) continue
		seen.add(name)
		normalized.push(name)
		if (normalized.length >= maxBulkPackageSecretApprovalNames) break
	}
	return normalized
}

export function buildSecretPackageBulkApprovalUrl(input: {
	baseUrl: string
	orgSlug: string
	packageId: string
	kodyId: string | null
	names: Array<string>
}) {
	const names = normalizeBulkPackageSecretApprovalNames(input.names)
	if (names.length === 0) {
		throw new Error('At least one secret name is required for bulk approval.')
	}
	const search = new URLSearchParams()
	search.set('package_id', input.packageId)
	if (input.kodyId) {
		search.set('package', input.kodyId)
	}
	search.set('names', names.join(','))
	return toOrgSecretPageUrl({
		baseUrl: input.baseUrl,
		accountPath: accountSecretsApprovePath,
		orgSlug: input.orgSlug,
		search: search.toString(),
	})
}

export function buildSecretPackageBulkApprovalUrlIfNeeded(input: {
	baseUrl: string
	orgSlug: string
	packageId: string
	kodyId: string | null
	names: Array<string>
}) {
	const names = normalizeBulkPackageSecretApprovalNames(input.names)
	if (names.length < 2) return null
	return buildSecretPackageBulkApprovalUrl({
		baseUrl: input.baseUrl,
		orgSlug: input.orgSlug,
		packageId: input.packageId,
		kodyId: input.kodyId,
		names,
	})
}
