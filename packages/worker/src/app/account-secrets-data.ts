import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { ownerIdFromCaller } from '#worker/request-context/owner-id.ts'
import {
	buildAccountSecretId,
	parseAccountSecretId,
	parseAccountSecretPath,
} from '@kody-internal/shared/account-secret-route.ts'
import { type AccountSecretsLoaderData } from '#universal/loader-data.ts'
import { type CredentialFillPlacementView } from '#universal/credential-fill-placement.ts'
import { type readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { type StorageContext } from '#mcp/storage.ts'
import {
	listPackageSecretsByPackageIds,
	listSecrets,
	resolveSecret,
} from '#mcp/secrets/service.ts'
import { type SecretScope } from '#mcp/secrets/types.ts'
import { type RejectedApprovalHost } from '#mcp/secrets/approval-host-shape.ts'
import { classifyBulkApprovalHosts } from '#mcp/secrets/host-approval.ts'
import { normalizeBulkPackageSecretApprovalNames } from '#mcp/secrets/package-approval-url.ts'
import { listSavedPackagesByUserId } from '#worker/package-registry/repo.ts'

type AuthenticatedUser = NonNullable<
	Awaited<ReturnType<typeof readAuthenticatedAppUser>>
>

type AccountEditableSecretScope = Extract<SecretScope, 'package' | 'user'>

type SavedPackageOption = {
	id: string
	title: string
	updatedAt: string
}

type SavedPackageSummary = {
	id: string
	kodyId: string
	name: string
	updatedAt: string
}

type AccountSecretListItem = {
	id: string
	name: string
	scope: AccountEditableSecretScope
	description: string
	packageId: string | null
	packageTitle: string | null
	allowedHosts: Array<string>
	allowedPackages: Array<string>
	createdAt: string
	updatedAt: string
	expiresAt: string | null
	ttlMs: number | null
	/** Null means anywhere. */
	placement: CredentialFillPlacementView | null
}

type AccountSecretDetail = AccountSecretListItem & {
	value: string
}

type SecretApprovalView = {
	name: string
	names: Array<string>
	scope: SecretScope
	requestedHost: string
	requestedHosts: Array<string>
	rejectedHosts: Array<RejectedApprovalHost>
	requestedPackageId: string | null
	currentAllowedHosts: Array<string>
	currentAllowedPackages: Array<string>
}

const secretsBasePath = '/account/secrets'

export function readAccountSecretsSelectedSecretId(requestUrl: string) {
	const url = new URL(requestUrl, 'http://localhost')
	const fromPath = readSelectedSecretIdFromPath(url.pathname)
	if (fromPath) return fromPath
	const fromQuery = url.searchParams.get('selected')
	return fromQuery?.trim() ? fromQuery.trim() : null
}

function readSelectedSecretIdFromPath(pathname: string) {
	if (pathname === `${secretsBasePath}/new`) return null
	if (pathname === `${secretsBasePath}/approve`) return null
	const parsedPath = parseAccountSecretPath(pathname)
	if (parsedPath) return parsedPath.id
	return null
}

export async function loadAccountSecretsSelection(input: {
	env: Env
	user: AuthenticatedUser
	selectedSecretId: string | null
	approval: {
		hosts: string[]
		names: string[]
		packageId?: string
		scope: 'user' | 'package' | 'session'
		storagePackageId?: string
		sessionId?: string
	}
	packageOptions?: Array<SavedPackageOption>
	savedPackages?: Array<SavedPackageSummary>
}): Promise<AccountSecretsLoaderData> {
	const requestedApprovalHosts = classifyBulkApprovalHosts(
		input.approval.hosts.flatMap((value) => value.split(',')),
	)
	const rejectedApprovalHosts = requestedApprovalHosts.rejected
	const requestedPackageId = input.approval.packageId?.trim() || null
	const requestedSecretNames = normalizeBulkPackageSecretApprovalNames(
		input.approval.names.flatMap((value) => value.split(',')),
	)
	const requestedHostScope = input.approval.scope
	const requestedHostStorageContext: StorageContext | null =
		requestedHostScope === 'package' && input.approval.storagePackageId?.trim()
			? {
					packageId: input.approval.storagePackageId.trim(),
					sessionId: null,
					appId: null,
				}
			: requestedHostScope === 'session' && input.approval.sessionId?.trim()
				? {
						sessionId: input.approval.sessionId.trim(),
						packageId: null,
						appId: null,
					}
				: null
	const savedPackages =
		input.savedPackages ??
		(await listSavedPackagesByUserId(input.env.APP_DB, {
			userId: ownerIdFromCaller({
				request: input.user.request,
				user: input.user.mcpUser,
			}),
		}))
	const packageOptions = input.packageOptions ?? toPackageOptions(savedPackages)
	const packageLookup = toAllowedPackageLookup(savedPackages)
	const secrets = await listAccountSecrets({
		env: input.env,
		user: input.user,
		packageOptions,
	})
	const selectedSecret = input.selectedSecretId
		? await resolveAccountSecretDetail({
				env: input.env,
				userId: ownerIdFromCaller({
					request: input.user.request,
					user: input.user.mcpUser,
				}),
				secretId: input.selectedSecretId,
				secrets,
			})
		: null

	let approval: SecretApprovalView | null = null
	let approvalError: string | null = null
	const hasApprovalTarget = Boolean(
		requestedApprovalHosts.valid.length > 0 ||
		rejectedApprovalHosts.length > 0 ||
		requestedPackageId,
	)
	const hasApprovalSubject = Boolean(
		input.selectedSecretId || requestedSecretNames.length > 0,
	)
	if (hasApprovalSubject && hasApprovalTarget) {
		try {
			approval = await resolveSecretApprovalView({
				env: input.env,
				userId: ownerIdFromCaller({
					request: input.user.request,
					user: input.user.mcpUser,
				}),
				secretId: input.selectedSecretId ?? null,
				requestedHosts: requestedApprovalHosts.valid,
				rejectedHosts: rejectedApprovalHosts,
				requestedPackageId,
				requestedSecretNames,
				requestedHostScope,
				requestedHostStorageContext,
				savedPackageIds: new Set(savedPackages.map((entry) => entry.id)),
			})
		} catch (error) {
			approvalError =
				error instanceof Error
					? error.message
					: 'Unable to read approval request.'
		}
	}

	return {
		ok: true,
		email: input.user.email,
		packageOptions,
		packages: Array.from(packageLookup.values()).map((packageEntry) => ({
			id: packageEntry.packageId,
			kodyId: packageEntry.kodyId,
			name: packageEntry.name,
		})),
		secrets,
		selectedSecret,
		approval,
		approvalError,
	}
}

async function listAccountSecrets(input: {
	env: Env
	user: AuthenticatedUser
	packageOptions: Array<SavedPackageOption>
}) {
	const packageTitles = new Map(
		input.packageOptions.map((packageOption) => [
			packageOption.id,
			packageOption.title,
		]),
	)
	const [userSecrets, packageSecrets] = await Promise.all([
		listSecrets({
			env: input.env,
			userId: ownerIdFromCaller({
				request: input.user.request,
				user: input.user.mcpUser,
			}),
			scope: 'user',
		}),
		listPackageSecretsByPackageIds({
			env: input.env,
			userId: ownerIdFromCaller({
				request: input.user.request,
				user: input.user.mcpUser,
			}),
			packageIds: input.packageOptions.map((packageOption) => packageOption.id),
		}),
	])

	return [
		...userSecrets.map((secret) =>
			toAccountSecretListItem(secret, packageTitles),
		),
		...Array.from(packageSecrets.values())
			.flat()
			.map((secret) => toAccountSecretListItem(secret, packageTitles)),
	].sort((left, right) => {
		return (
			left.name.localeCompare(right.name) ||
			left.scope.localeCompare(right.scope) ||
			(left.packageTitle ?? '').localeCompare(right.packageTitle ?? '')
		)
	})
}

type ResolvedSecretApproval =
	| {
			kind: 'host'
			name: string
			scope: SecretScope
			requestedHost: string
			rejectedHosts: Array<RejectedApprovalHost>
			storageContext: StorageContext | null
	  }
	| {
			kind: 'host_bulk'
			names: Array<string>
			hosts: Array<string>
			rejectedHosts: Array<RejectedApprovalHost>
			scope: SecretScope
			storageContext: StorageContext | null
	  }
	| {
			kind: 'package'
			name: string
			scope: SecretScope
			packageId: string
			storageContext: StorageContext | null
	  }
	| {
			kind: 'package_bulk'
			names: Array<string>
			scope: 'user'
			packageId: string
			storageContext: StorageContext | null
	  }

function resolveApprovalRequest(input: {
	secretId: string | null
	requestedHosts: Array<string>
	rejectedHosts?: Array<RejectedApprovalHost>
	requestedPackageId: string | null
	requestedSecretNames?: Array<string>
	requestedHostScope?: SecretScope
	requestedHostStorageContext?: StorageContext | null
}): ResolvedSecretApproval {
	const requestedSecretNames = normalizeBulkPackageSecretApprovalNames(
		input.requestedSecretNames ?? [],
	)
	const classified = classifyBulkApprovalHosts(input.requestedHosts)
	const requestedHosts = classified.valid
	const rejectedHosts = input.rejectedHosts ?? classified.rejected
	if (
		(requestedHosts.length > 0 || rejectedHosts.length > 0) &&
		input.requestedPackageId
	) {
		throw new Error('Approval request contains both host and package.')
	}
	if (requestedSecretNames.length > 0) {
		if (input.secretId) {
			throw new Error(
				'Approval request cannot combine selected secret and names list.',
			)
		}
		if (input.requestedPackageId) {
			return {
				kind: 'package_bulk',
				names: requestedSecretNames,
				scope: 'user',
				packageId: input.requestedPackageId,
				storageContext: null,
			}
		}
		if (requestedHosts.length === 0 && rejectedHosts.length === 0) {
			throw new Error('Bulk secret approval requires a package_id or hosts.')
		}
		return {
			kind: 'host_bulk',
			names: requestedSecretNames,
			hosts: requestedHosts,
			rejectedHosts,
			scope: input.requestedHostScope ?? 'user',
			storageContext: input.requestedHostStorageContext ?? null,
		}
	}
	const parsed = input.secretId ? parseAccountSecretId(input.secretId) : null
	if (!parsed) {
		throw new Error('Invalid approval request.')
	}
	const storageContext = getSecretContextForAccountSecret(parsed)
	if (input.requestedPackageId) {
		if (parsed.scope !== 'user') {
			throw new Error('Only user secrets support package approvals.')
		}
		return {
			kind: 'package',
			name: parsed.name,
			scope: parsed.scope,
			packageId: input.requestedPackageId,
			storageContext,
		}
	}
	if (requestedHosts.length === 1 && rejectedHosts.length === 0) {
		const requestedHost = requestedHosts[0]
		if (!requestedHost) {
			throw new Error('Invalid approval request host.')
		}
		return {
			kind: 'host',
			name: parsed.name,
			scope: parsed.scope,
			requestedHost,
			rejectedHosts,
			storageContext,
		}
	}
	if (requestedHosts.length > 0 || rejectedHosts.length > 0) {
		return {
			kind: 'host_bulk',
			names: [parsed.name],
			hosts: requestedHosts,
			rejectedHosts,
			scope: parsed.scope,
			storageContext,
		}
	}
	throw new Error('Approval request is missing a host or package.')
}

async function resolveSecretApprovalView(input: {
	env: Env
	userId: OwnerId
	secretId: string | null
	requestedHosts: Array<string>
	rejectedHosts: Array<RejectedApprovalHost>
	requestedPackageId: string | null
	requestedSecretNames: Array<string>
	requestedHostScope: SecretScope
	requestedHostStorageContext: StorageContext | null
	savedPackageIds: Set<string>
}) {
	const approval = resolveApprovalRequest({
		secretId: input.secretId,
		requestedHosts: input.requestedHosts,
		rejectedHosts: input.rejectedHosts,
		requestedPackageId: input.requestedPackageId,
		requestedSecretNames: input.requestedSecretNames,
		requestedHostScope: input.requestedHostScope,
		requestedHostStorageContext: input.requestedHostStorageContext,
	})
	if (approval.kind === 'package_bulk') {
		if (!input.savedPackageIds.has(approval.packageId)) {
			throw new Error('Package not found for approval.')
		}
		const secrets = await listSecrets({
			env: input.env,
			userId: input.userId,
			scope: 'user',
		})
		const byName = new Map(
			secrets
				.filter((secret) => secret.scope === 'user')
				.map((secret) => [secret.name, secret]),
		)
		const foundNames: Array<string> = []
		const pendingNames: Array<string> = []
		for (const name of approval.names) {
			const secret = byName.get(name)
			if (!secret) continue
			foundNames.push(name)
			if (!secret.allowedPackages.includes(approval.packageId)) {
				pendingNames.push(name)
			}
		}
		if (foundNames.length === 0) {
			throw new Error('None of the listed secrets were found.')
		}
		if (pendingNames.length === 0) {
			return {
				name: foundNames[0] ?? '',
				names: foundNames,
				scope: 'user',
				requestedHost: '',
				requestedHosts: [],
				rejectedHosts: [],
				requestedPackageId: approval.packageId,
				currentAllowedHosts: [],
				currentAllowedPackages: [approval.packageId],
			} satisfies SecretApprovalView
		}
		const firstPending = pendingNames[0]
		const firstSecret = firstPending ? byName.get(firstPending) : null
		return {
			name: firstPending ?? '',
			names: pendingNames,
			scope: 'user',
			requestedHost: '',
			requestedHosts: [],
			rejectedHosts: [],
			requestedPackageId: approval.packageId,
			currentAllowedHosts: firstSecret?.allowedHosts ?? [],
			currentAllowedPackages: firstSecret?.allowedPackages ?? [],
		} satisfies SecretApprovalView
	}
	if (approval.kind === 'host_bulk') {
		const secrets = await listSecrets({
			env: input.env,
			userId: input.userId,
			scope: approval.scope,
			storageContext: approval.storageContext,
		})
		const byName = new Map(
			secrets
				.filter((secret) => secret.scope === approval.scope)
				.map((secret) => [secret.name, secret]),
		)
		const foundNames: Array<string> = []
		for (const name of approval.names) {
			if (byName.has(name)) foundNames.push(name)
		}
		if (foundNames.length === 0) {
			throw new Error('None of the listed secrets were found.')
		}
		const firstSecret = byName.get(foundNames[0] ?? '')
		return {
			name: foundNames[0] ?? '',
			names: foundNames,
			scope: approval.scope,
			requestedHost: approval.hosts[0] ?? '',
			requestedHosts: approval.hosts,
			rejectedHosts: approval.rejectedHosts,
			requestedPackageId: null,
			currentAllowedHosts: firstSecret?.allowedHosts ?? [],
			currentAllowedPackages: firstSecret?.allowedPackages ?? [],
		} satisfies SecretApprovalView
	}
	const secrets = await listSecrets({
		env: input.env,
		userId: input.userId,
		scope: approval.scope,
		storageContext: approval.storageContext,
	})
	const secret = secrets.find(
		(item) => item.name === approval.name && item.scope === approval.scope,
	)
	if (!secret) {
		throw new Error('Secret not found.')
	}
	if (
		approval.kind === 'package' &&
		!input.savedPackageIds.has(approval.packageId)
	) {
		throw new Error('Package not found for approval.')
	}
	return {
		name: approval.name,
		names: [approval.name],
		scope: approval.scope,
		requestedHost: approval.kind === 'host' ? approval.requestedHost : '',
		requestedHosts: approval.kind === 'host' ? [approval.requestedHost] : [],
		rejectedHosts: approval.kind === 'host' ? approval.rejectedHosts : [],
		requestedPackageId: approval.kind === 'package' ? approval.packageId : null,
		currentAllowedHosts: secret.allowedHosts,
		currentAllowedPackages: secret.allowedPackages,
	} satisfies SecretApprovalView
}

async function resolveAccountSecretDetail(input: {
	env: Env
	userId: OwnerId
	secretId: string
	secrets: Array<AccountSecretListItem>
}) {
	const parsed = parseAccountSecretId(input.secretId)
	if (!parsed) return null

	const selected = input.secrets.find((secret) => secret.id === input.secretId)
	if (!selected) return null
	const resolved = await resolveSecret({
		env: input.env,
		userId: input.userId,
		name: parsed.name,
		scope: parsed.scope,
		includeExpired: true,
		storageContext: getSecretContextForAccountSecret(parsed),
	})
	return {
		...selected,
		value: resolved.found && resolved.value != null ? resolved.value : '',
	} satisfies AccountSecretDetail
}

function toAccountSecretListItem(
	secret: {
		name: string
		scope: SecretScope
		description: string
		packageId: string | null
		allowedHosts: Array<string>
		allowedPackages: Array<string>
		createdAt: string
		updatedAt: string
		expiresAt: string | null
		ttlMs: number | null
		placement?: AccountSecretListItem['placement']
	},
	packageTitles: Map<string, string>,
) {
	if (secret.scope === 'session') {
		throw new Error('Session secrets are not editable from the account page.')
	}
	const scope = secret.scope === 'package' ? 'package' : 'user'

	return {
		id: buildAccountSecretId({
			name: secret.name,
			scope,
			packageId: secret.packageId,
		}),
		name: secret.name,
		scope,
		description: secret.description,
		packageId: secret.packageId,
		packageTitle: secret.packageId
			? (packageTitles.get(secret.packageId) ?? null)
			: null,
		allowedHosts: secret.allowedHosts,
		allowedPackages: secret.allowedPackages,
		createdAt: secret.createdAt,
		updatedAt: secret.updatedAt,
		expiresAt: secret.expiresAt,
		ttlMs: secret.ttlMs,
		placement: secret.placement ?? null,
	} satisfies AccountSecretListItem
}

function toPackageOptions(
	savedPackages: Array<{
		id: string
		name: string
		updatedAt: string
	}>,
) {
	return savedPackages
		.map((savedPackage) => ({
			id: savedPackage.id,
			title: savedPackage.name,
			updatedAt: savedPackage.updatedAt,
		}))
		.sort((left, right) => {
			return (
				right.updatedAt.localeCompare(left.updatedAt) ||
				left.title.localeCompare(right.title)
			)
		})
}

function toAllowedPackageLookup(
	savedPackages: Array<{
		id: string
		kodyId: string
		name: string
	}>,
) {
	return new Map(
		savedPackages.map((savedPackage) => [
			savedPackage.id,
			{
				packageId: savedPackage.id,
				kodyId: savedPackage.kodyId,
				name: savedPackage.name,
			},
		]),
	)
}

export function getSecretContextForAccountSecret(input: {
	scope: SecretScope
	packageId: string | null
	sessionId?: string | null
}): StorageContext {
	return {
		sessionId: input.scope === 'session' ? (input.sessionId ?? null) : null,
		appId: null,
		packageId: input.scope === 'package' ? input.packageId : null,
	}
}

export { listAccountSecrets, resolveApprovalRequest, toPackageOptions }
