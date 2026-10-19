import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { type McpCallerContext } from '@kody-internal/shared/chat.ts'
import { McpCallerError } from '#mcp/caller-error.ts'

import { getOrgById } from '#worker/orgs/repo.ts'
import {
	buildSecretPackageApprovalUrl,
	buildSecretPackageBulkApprovalUrlIfNeeded,
	secretPageOrgSlugFromCaller,
} from './package-approval-url.ts'
import {
	createPackageSecretAccessDeniedBatchMessage,
	createPackageSecretAccessDeniedMessage,
} from './errors.ts'
import { findSecret, type FoundSecret } from './service.ts'
import { type SecretScope } from './types.ts'
import { type StorageContext } from '#mcp/storage.ts'
import { resolveCallerSecretAuthority } from './secret-authority.ts'
import { getCommunityForkByForkedPackageId } from '#worker/community/repo.ts'
import { getSavedPackageById } from '#worker/package-registry/repo.ts'
import {
	loadPackageManifestBySourceId,
	type LoadedPackageManifest,
} from '#worker/package-registry/source.ts'
import { type SavedPackageRecord } from '#worker/package-registry/types.ts'

type SecretMountDefinition = {
	name: string
	scope?: SecretScope
}

/**
 * Package secret mount/approval failures the caller can clear (approve the
 * package, declare a mount, create the secret). Subclass McpCallerError so
 * MCP observability keeps them off Sentry — they are policy denials, not
 * platform defects.
 */
export class PackageSecretMountError extends McpCallerError {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options)
		this.name = 'PackageSecretMountError'
	}
}
export class PackageSecretMissingError extends McpCallerError {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options)
		this.name = 'PackageSecretMissingError'
	}
}
export class PackageSecretAccessDeniedError extends McpCallerError {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options)
		this.name = 'PackageSecretAccessDeniedError'
	}
}

export function isPackageSecretAccessUnavailableError(error: unknown) {
	return (
		error instanceof PackageSecretMountError ||
		error instanceof PackageSecretMissingError ||
		error instanceof PackageSecretAccessDeniedError
	)
}

/**
 * Concurrent package-access checks for the same (user, package) while
 * fetch-gateway resolves N secrets share one D1 load (KODY-9K). Cleared when
 * the promise settles so a later adopt/unadopt still re-reads.
 */
const inflightImplicitUserSecretAccess = new WeakMap<
	D1Database,
	Map<string, Promise<boolean>>
>()

/**
 * Self-authored packages (no `community_forks` row) and adopted community
 * forks may read/use user secrets without an explicit `allowed_packages`
 * grant. Missing packages and unadopted forks do not. Host allowlists are
 * a separate gate and are never implied by this check.
 */
export async function packageHasImplicitUserSecretReadAccess(input: {
	env: Pick<Env, 'APP_DB'>
	userId: OwnerId
	packageId: string
}): Promise<boolean> {
	const db = input.env.APP_DB
	const cacheKey = `${input.userId}\0${input.packageId}`
	let inflight = inflightImplicitUserSecretAccess.get(db)
	if (!inflight) {
		inflight = new Map()
		inflightImplicitUserSecretAccess.set(db, inflight)
	}
	const existing = inflight.get(cacheKey)
	if (existing) return existing
	const pending = loadImplicitUserSecretReadAccess(input).finally(() => {
		if (inflight.get(cacheKey) === pending) inflight.delete(cacheKey)
	})
	inflight.set(cacheKey, pending)
	return pending
}

async function loadImplicitUserSecretReadAccess(input: {
	env: Pick<Env, 'APP_DB'>
	userId: OwnerId
	packageId: string
}): Promise<boolean> {
	const savedPackage = await getSavedPackageById(input.env.APP_DB, {
		userId: input.userId,
		packageId: input.packageId,
	})
	if (!savedPackage) return false
	return await savedPackageHasImplicitUserSecretReadAccess({
		db: input.env.APP_DB,
		userId: input.userId,
		savedPackage,
	})
}

async function savedPackageHasImplicitUserSecretReadAccess(input: {
	db: D1Database
	userId: OwnerId
	savedPackage: SavedPackageRecord
}): Promise<boolean> {
	const communityFork = await getCommunityForkByForkedPackageId(input.db, {
		forkerUserId: input.userId,
		forkedPackageId: input.savedPackage.id,
	})
	return !communityFork || Boolean(communityFork.adoptedAt)
}

export async function resolveSecretPageOrgSlug(input: {
	db: D1Database
	userId: OwnerId
	orgSlug?: string | null
	caller?: Parameters<typeof secretPageOrgSlugFromCaller>[0]
}) {
	try {
		const org = await getOrgById(input.db, input.userId)
		const slug = org?.slug?.trim()
		if (slug) return slug
	} catch {
		// Test doubles that do not model orgs keep the provided or username slug.
	}
	const provided = input.orgSlug?.trim()
	if (provided) return provided
	if (input.caller) {
		const fromCaller = secretPageOrgSlugFromCaller(input.caller)
		if (fromCaller) return fromCaller
	}
	return input.caller?.user?.username?.trim() || null
}

export async function assertPackageCanAccessResolvedSecret(input: {
	env: Pick<Env, 'APP_DB'>
	baseUrl: string
	orgSlug?: string | null
	userId: OwnerId
	storageContext:
		| {
				sessionId?: string | null
				appId?: string | null
				packageId?: string | null
				storageId?: string | null
		  }
		| null
		| undefined
	secretName: string
	resolved: FoundSecret
	/** Default `'use'` (read/resolve). `'mutate'` always requires allowed_packages. */
	intent?: 'use' | 'mutate'
	/**
	 * Stamp / call-site package id. When omitted, the bundled-run ALS or
	 * `storageContext.packageId` (the run) is used.
	 */
	authorityPackageId?: string | null
}) {
	const { authorityPackageId: packageId } = resolveCallerSecretAuthority({
		storageContext: input.storageContext,
		authorityPackageId: input.authorityPackageId,
	})
	if (!packageId || input.resolved.scope !== 'user') return
	if (input.resolved.allowedPackages.includes(packageId)) return

	const intent = input.intent ?? 'use'
	// Route `use` through the shared in-flight map so multi-secret fetch
	// auth shares one package + fork load (KODY-9K). Missing packages still
	// fall through to the explicit not-found error below.
	if (
		intent === 'use' &&
		(await packageHasImplicitUserSecretReadAccess({
			env: input.env,
			userId: input.userId,
			packageId,
		}))
	) {
		return
	}

	const savedPackage = await getSavedPackageById(input.env.APP_DB, {
		userId: input.userId,
		packageId,
	})
	if (!savedPackage) {
		throw new PackageSecretAccessDeniedError(
			`Package "${packageId}" was not found for secret access.`,
		)
	}

	const orgSlug = await resolveSecretPageOrgSlug({
		db: input.env.APP_DB,
		userId: input.userId,
		orgSlug: input.orgSlug,
	})
	const approvalUrl = orgSlug
		? buildSecretPackageApprovalUrl({
				baseUrl: input.baseUrl,
				orgSlug,
				name: input.secretName,
				scope: 'user',
				packageId: savedPackage.id,
				kodyId: savedPackage.kodyId,
				storageContext: {
					sessionId: input.storageContext?.sessionId ?? null,
					appId: input.storageContext?.appId ?? null,
					packageId,
					storageId: input.storageContext?.storageId ?? null,
				},
			})
		: null
	throw new PackageSecretAccessDeniedError(
		createPackageSecretAccessDeniedMessage({
			secretName: input.secretName,
			packageName: savedPackage.kodyId,
			approvalUrl,
		}),
	)
}

/**
 * Fail-closed authorization check for secret writes. Call this before any
 * provider token request that may rotate refresh tokens so a later permission
 * denial cannot strand the integration. Writes from package code always
 * require an `allowed_packages` grant.
 */
export async function assertCanSetSecrets(input: {
	env: Pick<Env, 'APP_DB' | 'SECRET_STORE_KEY'>
	userId: OwnerId
	baseUrl: string
	orgSlug?: string | null
	secrets: Array<{
		name: string
		scope: SecretScope
	}>
	storageContext?: StorageContext | null
}) {
	if (input.secrets.length === 0) {
		throw new Error('At least one secret is required.')
	}
	const storageContext: StorageContext | null = input.storageContext
		? {
				sessionId: input.storageContext.sessionId ?? null,
				appId: input.storageContext.appId ?? null,
				packageId: input.storageContext.packageId ?? null,
				storageId: input.storageContext.storageId ?? null,
			}
		: null
	const { authorityPackageId, storageContext: authorityStorageContext } =
		resolveCallerSecretAuthority({ storageContext })
	for (const secret of input.secrets) {
		const name = secret.name.trim()
		if (!name) throw new Error('Secret name is required.')
		if (secret.scope === 'user' && authorityPackageId) {
			const resolved = await findSecret({
				env: input.env,
				userId: input.userId,
				name,
				scope: 'user',
				storageContext: authorityStorageContext,
			})
			if (!resolved.found) {
				throw new McpCallerError(
					'Package runtimes cannot create user-scoped secrets. Create the secret from the account page and approve the package first.',
				)
			}
			await assertPackageCanAccessResolvedSecret({
				env: input.env,
				baseUrl: input.baseUrl,
				orgSlug: input.orgSlug,
				userId: input.userId,
				storageContext: authorityStorageContext,
				authorityPackageId,
				secretName: name,
				resolved,
				intent: 'mutate',
			})
		}
	}
}

export async function loadPackageSecretMounts(input: {
	env: Env
	baseUrl: string
	userId: OwnerId
	packageId: string
}): Promise<{
	savedPackage: {
		id: string
		kodyId: string
		name: string
		sourceId: string
	}
	manifest: LoadedPackageManifest['manifest']
	mounts: Record<string, SecretMountDefinition>
}> {
	const savedPackage = await getSavedPackageById(input.env.APP_DB, {
		userId: input.userId,
		packageId: input.packageId,
	})
	if (!savedPackage) {
		throw new Error(`Saved package "${input.packageId}" was not found.`)
	}
	const loaded = await loadPackageManifestBySourceId({
		env: input.env,
		baseUrl: input.baseUrl,
		userId: input.userId,
		sourceId: savedPackage.sourceId,
	})
	return {
		savedPackage: {
			id: savedPackage.id,
			kodyId: savedPackage.kodyId,
			name: savedPackage.name,
			sourceId: savedPackage.sourceId,
		},
		manifest: loaded.manifest,
		mounts: loaded.manifest.kody.secretMounts ?? {},
	}
}

export async function findMissingPackageApprovals(input: {
	env: Env
	baseUrl: string
	orgSlug?: string | null
	userId: OwnerId
	packageId: string
	mounts: Record<string, SecretMountDefinition>
	storageContext: McpCallerContext['storageContext']
}) {
	const savedPackage = await getSavedPackageById(input.env.APP_DB, {
		userId: input.userId,
		packageId: input.packageId,
	})
	if (!savedPackage) {
		throw new Error(`Saved package "${input.packageId}" was not found.`)
	}
	if (
		await savedPackageHasImplicitUserSecretReadAccess({
			db: input.env.APP_DB,
			userId: input.userId,
			savedPackage,
		})
	) {
		return []
	}

	const storageContext = {
		sessionId: input.storageContext?.sessionId ?? null,
		appId: input.storageContext?.appId ?? null,
		packageId: input.storageContext?.packageId ?? null,
		storageId: input.storageContext?.storageId ?? null,
	}
	const orgSlug = await resolveSecretPageOrgSlug({
		db: input.env.APP_DB,
		userId: input.userId,
		orgSlug: input.orgSlug,
	})
	const entries = await Promise.all(
		Object.values(input.mounts).map(async (mount) => {
			const resolved = await findSecret({
				env: input.env,
				userId: input.userId,
				name: mount.name,
				scope: mount.scope,
				storageContext,
			})
			if (!resolved.found) return null
			if (resolved.scope !== 'user') return null
			if (resolved.allowedPackages.includes(savedPackage.id)) {
				return null
			}
			return {
				secretName: mount.name,
				packageId: savedPackage.id,
				kodyId: savedPackage.kodyId,
				approvalUrl: orgSlug
					? buildSecretPackageApprovalUrl({
							baseUrl: input.baseUrl,
							orgSlug,
							name: mount.name,
							scope: resolved.scope ?? mount.scope ?? 'user',
							packageId: savedPackage.id,
							kodyId: savedPackage.kodyId,
							storageContext,
						})
					: '',
			}
		}),
	)
	return entries.filter((entry) => entry != null)
}

function orgSlugFromSecretPageUrl(url: string) {
	try {
		const match = /^\/@([^/]+)\/-\/secrets(?:\/|$)/.exec(new URL(url).pathname)
		return match?.[1] ?? null
	} catch {
		return null
	}
}

export function buildPackageApprovalErrorForMounts(input: {
	entries: Array<{
		secretName: string
		packageId: string
		kodyId: string
		approvalUrl: string
	}>
	baseUrl?: string
	orgSlug?: string | null
}) {
	if (input.entries.length === 0) {
		return null
	}
	if (input.entries.length === 1) {
		const only = input.entries[0]
		if (!only) return null
		return createPackageSecretAccessDeniedMessage({
			secretName: only.secretName,
			packageName: only.kodyId,
			approvalUrl: only.approvalUrl,
		})
	}
	const packageIds = new Set(input.entries.map((entry) => entry.packageId))
	const first = input.entries[0]
	const baseUrl =
		input.baseUrl ??
		(first
			? (() => {
					try {
						return new URL(first.approvalUrl).origin
					} catch {
						return null
					}
				})()
			: null)
	const orgSlug =
		input.orgSlug?.trim() ||
		(first ? orgSlugFromSecretPageUrl(first.approvalUrl) : null)
	const bulkApprovalUrl =
		packageIds.size === 1 && first && baseUrl && orgSlug
			? buildSecretPackageBulkApprovalUrlIfNeeded({
					baseUrl,
					orgSlug,
					packageId: first.packageId,
					kodyId: first.kodyId,
					names: input.entries.map((entry) => entry.secretName),
				})
			: null
	return createPackageSecretAccessDeniedBatchMessage(
		input.entries.map((entry) => ({
			secretName: entry.secretName,
			packageId: entry.packageId,
			kodyId: entry.kodyId,
			packageName: entry.kodyId,
			approvalUrl: entry.approvalUrl,
		})),
		{ bulkApprovalUrl },
	)
}
