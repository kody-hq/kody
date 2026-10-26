import { type McpCallerContext } from '@kody-internal/shared/chat.ts'
import { type RequestContext } from '@kody-internal/shared/request-context.ts'
import {
	type AdditionalKodyTools,
	type PackageSecretToolOptions,
} from '#mcp/runtime-helper-manifest.ts'
import { authorize, packageResource } from '#worker/authorization/authorize.ts'
import { getSavedPackageById } from '#worker/package-registry/repo.ts'
import { ownerIdFromCaller } from '#worker/request-context/owner-id.ts'
import {
	createPackageStorageAccessDeniedMessage,
	createPackageStorageKodyTools,
} from '#worker/storage-runner.ts'
import { claimedPackageStamp } from '#worker/credentials/package-stamp.ts'
import { resolveCredential } from '#worker/credentials/resolve-credential.ts'
import { verifyLocalExecutePackageBinding } from '#worker/package-runtime/local-execute-package-binding.ts'

/**
 * Local-execute CapabilityProxy packageStorage / packageSecrets host tools.
 *
 * Cloud execute builds a bundler provenance grant set once per run. Local
 * execute has no sandbox graph on origin per hop, so the package graph signs
 * one binding per package it serves (`local-execute-package-binding.ts`) and
 * the local runtime shim sends that binding, never a bare package id. Each
 * call verifies the binding was minted for this org and actor, then checks the
 * package is in the org and the actor holds `package:execute` on it. The
 * result is still a `claimed` package stamp: packageSecrets also require
 * `secret:use` on the mounted secret (same as ad-hoc). Gateway /
 * authenticatedFetch / oauthClientCredentials / credential clients use the
 * same binding check.
 */

function isPackageSecretAvailabilityError(error: unknown) {
	return (
		error instanceof Error &&
		(error.message.startsWith('Secret "') ||
			error.message.startsWith('Package "'))
	)
}

async function authorizeLocalExecutePackageId(input: {
	env: Env
	callerContext: McpCallerContext
	packageBinding: unknown
}) {
	const orgUserId = ownerIdFromCaller(input.callerContext)
	if (!orgUserId) {
		throw new Error(
			'packageStorage / packageSecrets require an authenticated user.',
		)
	}
	const authorizedPackageId = await authorizeLocalExecutePackageBinding({
		db: input.env.APP_DB,
		env: input.env,
		request: input.callerContext.request,
		orgUserId,
		packageBinding: input.packageBinding,
	})
	return {
		userId: orgUserId,
		packageId: authorizedPackageId,
		grantedPackageIds: new Set([authorizedPackageId]),
	}
}

function readPackageBindingFromArgs(args: unknown) {
	if (args == null || typeof args !== 'object' || Array.isArray(args)) {
		return { binding: '', rest: {} as Record<string, unknown> }
	}
	const { packageId, ...rest } = args as Record<string, unknown>
	return {
		binding: typeof packageId === 'string' ? packageId.trim() : '',
		rest,
	}
}

function readPackageSecretCall(args: unknown) {
	const { binding, rest } = readPackageBindingFromArgs(args)
	const alias = 'alias' in rest ? String(rest.alias ?? '').trim() : ''
	return { alias, binding }
}

/**
 * Confirm the stamped package lives in the bound org and the acting person
 * holds `package:execute` on it. Org ownership alone is not enough: a member
 * with execute on package A must not stamp package B to skip ad-hoc
 * credential Use checks.
 */
export async function authorizeLocalExecuteOwnedPackageId(input: {
	db: D1Database
	env: Env
	request: RequestContext | null
	orgUserId: string
	packageId: string
}) {
	const owned = await getSavedPackageById(input.db, {
		userId: input.orgUserId,
		packageId: input.packageId,
	})
	if (!owned) {
		throw new Error(createPackageStorageAccessDeniedMessage(input.packageId))
	}
	await authorize(
		{ env: input.env, request: input.request },
		'package:execute',
		packageResource({
			id: input.packageId,
			userId: input.orgUserId,
			label: owned.name || owned.kodyId,
		}),
	)
	return input.packageId
}

/**
 * Verify a local package binding (signed by the package graph for this org
 * and actor), then run the `package:execute` check above on the package it
 * names. A bare package id fails, so sandbox code cannot claim a package
 * identity by naming it.
 */
export async function authorizeLocalExecutePackageBinding(input: {
	db: D1Database
	env: Env
	request: RequestContext | null
	orgUserId: string
	packageBinding: unknown
}) {
	const packageId = await verifyLocalExecutePackageBinding({
		env: input.env,
		token: input.packageBinding,
		subject: {
			org: input.orgUserId,
			actor: input.request?.actor?.userId ?? null,
		},
	})
	return await authorizeLocalExecuteOwnedPackageId({
		db: input.db,
		env: input.env,
		request: input.request,
		orgUserId: input.orgUserId,
		packageId,
	})
}

export async function createCapabilityProxyPackageHostTools(input: {
	env: Env
	callerContext: McpCallerContext
}): Promise<AdditionalKodyTools> {
	const orgUserId = ownerIdFromCaller(input.callerContext)
	if (!orgUserId) return {}

	const storageToolsByPackageId = new Map<
		string,
		{
			tools: ReturnType<typeof createPackageStorageKodyTools>
			grantedPackageIds: ReadonlySet<string>
		}
	>()

	const storageToolsFor = async (packageBinding: string) => {
		const authorized = await authorizeLocalExecutePackageId({
			env: input.env,
			callerContext: input.callerContext,
			packageBinding,
		})
		let entry = storageToolsByPackageId.get(authorized.packageId)
		if (!entry) {
			entry = {
				tools: createPackageStorageKodyTools({
					env: input.env,
					userId: authorized.userId,
					email: input.callerContext.user?.email ?? null,
					grantedPackageIds: authorized.grantedPackageIds,
					// The verified binding is the calling package, so its bucket
					// passes the owner-only check (same as a hosted bound call).
					runPackageId: authorized.packageId,
				}),
				grantedPackageIds: authorized.grantedPackageIds,
			}
			storageToolsByPackageId.set(authorized.packageId, entry)
		}
		return entry
	}

	const resolveSecretAuthority = async (packageBinding: string | null) => {
		if (!packageBinding) {
			throw new Error(
				'Package secret access requires a matching server-side package runtime context.',
			)
		}
		return authorizeLocalExecutePackageId({
			env: input.env,
			callerContext: input.callerContext,
			packageBinding,
		})
	}

	const resolveClaimedMount = (inputMount: {
		packageId: string
		alias: string
		access?: 'presence' | 'value'
	}) =>
		resolveCredential({
			env: input.env,
			orgId: orgUserId,
			actor: input.callerContext.request,
			packageStamp: claimedPackageStamp(inputMount.packageId),
			baseUrl: input.callerContext.baseUrl,
			credential: {
				use: 'package-secret-mount',
				alias: inputMount.alias,
				callerContext: input.callerContext,
				...(inputMount.access ? { access: inputMount.access } : {}),
			},
		})

	const packageSecretTools: PackageSecretToolOptions = {
		runPackageId: null,
		get: async (alias, requestedPackageId) => {
			const authorized = await resolveSecretAuthority(
				requestedPackageId ?? null,
			)
			return (
				await resolveClaimedMount({
					packageId: authorized.packageId,
					alias,
				})
			).ref
		},
		has: async (alias, requestedPackageId) => {
			const authorized = await resolveSecretAuthority(
				requestedPackageId ?? null,
			)
			try {
				await resolveClaimedMount({
					packageId: authorized.packageId,
					alias,
					access: 'presence',
				})
				return true
			} catch (error) {
				if (isPackageSecretAvailabilityError(error)) return false
				throw error
			}
		},
	}

	// The storage tools read `packageId` from args and check it against the
	// granted set, so hand them the verified id in place of the binding.
	const storageCall = async (
		name:
			| 'packageStorageGet'
			| 'packageStorageList'
			| 'packageStorageSql'
			| 'packageStorageSet'
			| 'packageStorageDelete'
			| 'packageStorageClear',
		args: unknown,
	) => {
		const { binding, rest } = readPackageBindingFromArgs(args)
		const entry = await storageToolsFor(binding)
		const authorizedPackageId = [...entry.grantedPackageIds][0]!
		const tool = entry.tools[name]
		if (!tool) {
			throw new Error(`${name} is not available in this context.`)
		}
		return await tool({ ...rest, packageId: authorizedPackageId })
	}

	return {
		packageStorageGet: async (args: unknown) =>
			storageCall('packageStorageGet', args),
		packageStorageList: async (args: unknown) =>
			storageCall('packageStorageList', args),
		packageStorageSql: async (args: unknown) =>
			storageCall('packageStorageSql', args),
		packageStorageSet: async (args: unknown) =>
			storageCall('packageStorageSet', args),
		packageStorageDelete: async (args: unknown) =>
			storageCall('packageStorageDelete', args),
		packageStorageClear: async (args: unknown) =>
			storageCall('packageStorageClear', args),
		packageSecretGet: async (args: unknown) => {
			const { alias, binding } = readPackageSecretCall(args)
			return {
				value: await packageSecretTools.get(alias, binding || null),
			}
		},
		packageSecretHas: async (args: unknown) => {
			const { alias, binding } = readPackageSecretCall(args)
			return {
				has: await packageSecretTools.has(alias, binding || null),
			}
		},
	}
}
