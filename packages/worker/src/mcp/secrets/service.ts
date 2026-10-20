import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { sha256Hex } from '@kody-internal/shared/sha256.ts'
import {
	earliestSecretExpiresAt,
	isSecretExpired,
	nextSecretExpiresAt,
	secretTtlMs,
} from '@kody-internal/shared/secret-expires-at.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import {
	type CredentialFillPlacement,
	defaultNewCredentialFillPlacement,
	readCredentialFillPlacement,
} from '#worker/credentials/fill-placement.ts'
import { assertOptInCredentialValue } from '#worker/credentials/opt-in-credential-value.ts'
import {
	normalizeAllowedPackages,
	parseAllowedPackages,
	stringifyAllowedPackages,
} from './allowed-packages.ts'
import {
	normalizeAllowedHosts,
	parseAllowedHosts,
	stringifyAllowedHosts,
} from './allowed-hosts.ts'
import {
	decryptSecretValue,
	encryptSecretValue,
	userSecretContext,
} from './crypto.ts'
import { rotateWebhookHmacSecretsForSecretValueChange } from '#worker/webhooks/hmac-rotation.ts'
import { assertSecretNameAllowed, isReservedSecretName } from './name-guards.ts'
import {
	getSecretBindingKey,
	resolveSecretListScopeOrder,
	resolveSecretScopeOrder,
} from './secret-bindings.ts'
import { type StorageContext } from '#mcp/storage.ts'
import {
	deleteSecretEntry,
	getSecretBucket,
	getSecretEntry,
	getStoredCredentialEntry,
	listPackageScopeSecretMetadata,
	listSecretBucketsByScope,
	listSecretMetadataForBucket,
	listUserScopeSecretMetadata,
	prepareUpsertCredentialSecretEntryStatement,
	renameSecretEntry,
	updateApprovedUserSecretEntriesForPackageAtomically,
	upsertSecretBucket,
	upsertSecretEntry,
	upsertSecretEntriesAtomically,
} from './repo.ts'
import {
	assertWithinEntitlement,
	assertWithinStorageBytesEntitlement,
	estimateEntitlementStorageEntryByteDelta,
} from '#worker/entitlements/service.ts'
import { type UserMeterEnv } from '#worker/entitlements/user-meter-client.ts'
import {
	type ListedSecret,
	type SecretMetadata,
	type SecretScope,
	type StoredCredentialKind,
} from './types.ts'
import {
	type OrgAuditOutboxEvent,
	type OrgAuditWriter,
	runAppDbBatchWithOrgAudit,
} from '#worker/orgs/org-audit.ts'
import { getSavedPackageById } from '#worker/package-registry/repo.ts'
import { stampFirstSecret } from '#worker/identity/activation-stamps.ts'

type SecretOwnerContext = {
	userId: OwnerId
	storageContext?: StorageContext | null
}

type SecretWriteEnv = Pick<Env, 'APP_DB' | 'SECRET_STORE_KEY'> & UserMeterEnv

type SaveSecretInput = SecretOwnerContext & {
	env: SecretWriteEnv
	scope: SecretScope
	name: string
	value: string
	description?: string | null
	expiresAt?: string | null
	sessionExpiresAt?: string | null
	userEmail?: string | null
	waitUntil?: (promise: Promise<unknown>) => void
	credential?: SaveSecretCredential
	/**
	 * Placement written only when inserting a new `(bucket, name)` row.
	 * Omitted → headers-only default. Explicit `null` preserves anywhere when
	 * a scope/package move copies an existing credential into a new bucket.
	 */
	placementOnInsert?: CredentialFillPlacement | null
}

/**
 * Opt-in credential fields (ADR 0068) committed in the same batch as the
 * value and its audit event, so a failed call never leaves a new value under
 * old settings.
 */
export type SaveSecretCredential = {
	kind: StoredCredentialKind
	/** Null keeps the entry's current hosts (a Key's approved hosts). */
	allowedHosts: Array<string> | null
	configJson: string | null
	provider: string | null
	injectJson: string
	/** Null means anywhere (placeholders may fill any request part). */
	placementJson: string | null
	audit: {
		writer: OrgAuditWriter
		event: (credentialId: string) => OrgAuditOutboxEvent
	}
}

type ListSecretsInput = SecretOwnerContext & {
	env: Pick<Env, 'APP_DB'>
	scope?: SecretScope | null
}

type ResolveSecretInput = SecretOwnerContext & {
	env: Pick<Env, 'APP_DB' | 'SECRET_STORE_KEY'>
	name: string
	scope?: SecretScope | null
	includeExpired?: boolean
}

type UpdateSecretInput = SecretOwnerContext & {
	env: Pick<Env, 'APP_DB' | 'SECRET_STORE_KEY'>
	name: string
	scope: SecretScope
	value?: string | null
	description?: string | null
	expiresAt?: string | null
}

type DeleteSecretInput = SecretOwnerContext & {
	env: Pick<Env, 'APP_DB'>
	name: string
	scope: SecretScope
}

export type ResolvedSecret = {
	found: boolean
	/** Stable credential id of the entry that resolved; null when not found. */
	credentialId: string | null
	value: string | null
	scope: SecretScope | null
	allowedHosts: Array<string>
	allowedPackages: Array<string>
	/** Null means anywhere (placeholders may fill any request part). */
	placement: CredentialFillPlacement | null
}

/**
 * A new value for an opt-in credential (ADR 0068) must still fit its kind and
 * stored hosts, whichever path writes it, so it is never saved in a state
 * resolution refuses. Keys are unaffected.
 */
function assertValueFitsStoredKind(
	entry: { kind: StoredCredentialKind; allowed_hosts: string } | null,
	value: string,
) {
	if (!entry || entry.kind === 'secret') return
	assertOptInCredentialValue({
		kind: entry.kind,
		value,
		hosts: parseAllowedHosts(entry.allowed_hosts),
	})
}

export async function saveSecret(
	input: SaveSecretInput,
): Promise<SecretMetadata> {
	const name = input.name.trim()
	if (!name) {
		throw new Error('Secret name is required.')
	}
	assertSecretNameAllowed(name)
	const value = input.value.trim()
	if (!value) {
		throw new Error('Secret value is required.')
	}
	const description = input.description?.trim() ?? ''
	const credential = input.credential ?? null
	if (credential && input.scope !== 'user') {
		throw new Error('Credential fields apply only to user-scope secrets.')
	}
	const bucket = await getOrCreateSecretBucket({
		db: input.env.APP_DB,
		userId: input.userId,
		scope: input.scope,
		storageContext: input.storageContext ?? null,
		sessionExpiresAt: input.sessionExpiresAt ?? null,
	})
	const existingEntry = await getSecretEntry({
		db: input.env.APP_DB,
		bucketId: bucket.id,
		name,
	})
	// With credential fields, the caller validated the value for its new kind.
	if (!credential) assertValueFitsStoredKind(existingEntry, value)
	if (existingEntry == null) {
		await assertWithinEntitlement({
			db: input.env.APP_DB,
			userId: input.userId,
			email: input.userEmail,
			resource: 'secrets',
		})
	}
	const encryptedValue = await encryptSecretValue(
		input.env,
		value,
		userSecretContext(input.userId),
	)
	const allowedHostsJson = credential?.allowedHosts
		? JSON.stringify(credential.allowedHosts)
		: (existingEntry?.allowed_hosts ?? '[]')
	await assertWithinStorageBytesEntitlement({
		db: input.env.APP_DB,
		env: input.env,
		userId: input.userId,
		email: input.userEmail,
		requested: estimateEntitlementStorageEntryByteDelta({
			next: {
				key: name,
				value: {
					description,
					encryptedValue,
					allowedHosts: allowedHostsJson,
					allowedPackages: existingEntry?.allowed_packages ?? '[]',
				},
			},
			existing: existingEntry
				? {
						key: existingEntry.name,
						value: {
							description: existingEntry.description,
							encryptedValue: existingEntry.encrypted_value,
							allowedHosts: existingEntry.allowed_hosts,
							allowedPackages: existingEntry.allowed_packages,
						},
					}
				: null,
		}),
	})
	let previousPlaintext: string | null = null
	if (existingEntry) {
		try {
			previousPlaintext = await decryptSecretValue(
				input.env,
				existingEntry.encrypted_value,
				userSecretContext(input.userId),
			)
		} catch {
			previousPlaintext = null
		}
	}
	const now = new Date().toISOString()
	const entryExpiresAt = nextSecretExpiresAt({
		existing: existingEntry?.expires_at,
		requested: input.expiresAt,
	})
	const row = {
		bucket_id: bucket.id,
		name,
		description,
		encrypted_value: encryptedValue,
		allowed_hosts: allowedHostsJson,
		allowed_packages: existingEntry?.allowed_packages ?? '[]',
		expires_at: entryExpiresAt,
		created_at: existingEntry?.created_at ?? now,
		updated_at: now,
	}
	if (credential) {
		const credentialId = existingEntry?.id ?? crypto.randomUUID()
		await runAppDbBatchWithOrgAudit({
			appDb: input.env.APP_DB,
			audit: credential.audit.writer,
			statements: [
				prepareUpsertCredentialSecretEntryStatement({
					db: input.env.APP_DB,
					row,
					credential: {
						id: credentialId,
						kind: credential.kind,
						config_json: credential.configJson,
						provider: credential.provider,
						inject_json: credential.injectJson,
						placement_json: credential.placementJson,
					},
				}),
			],
			event: credential.audit.event(credentialId),
		})
	} else {
		await upsertSecretEntry({
			db: input.env.APP_DB,
			row,
			...('placementOnInsert' in input
				? { placementOnInsert: input.placementOnInsert ?? null }
				: {}),
		})
	}
	if (
		previousPlaintext !== null &&
		previousPlaintext !== value &&
		(input.scope === 'user' || input.scope === 'package')
	) {
		await rotateWebhookHmacSecretsForSecretValueChange({
			env: input.env,
			userId: input.userId,
			secretName: name,
			previousPlaintext,
			nextPlaintext: value,
			now,
			...(input.scope === 'package' ? { packageId: bucket.binding_key } : {}),
		})
	}
	if (existingEntry == null && input.scope === 'user') {
		await stampFirstSecret(
			input.env.APP_DB,
			{ stableUserId: input.userId, at: now },
			input.env,
		)
	}
	const placementAfter = credential
		? readCredentialFillPlacement(credential.placementJson)
		: existingEntry != null
			? readCredentialFillPlacement(existingEntry.placement_json)
			: 'placementOnInsert' in input
				? (input.placementOnInsert ?? null)
				: defaultNewCredentialFillPlacement
	return toSecretMetadata({
		name,
		scope: input.scope,
		description,
		packageId: input.scope === 'package' ? bucket.binding_key : null,
		allowedHosts: parseAllowedHosts(allowedHostsJson),
		allowedPackages: existingEntry
			? parseAllowedPackages(existingEntry.allowed_packages)
			: [],
		createdAt: existingEntry?.created_at ?? now,
		updatedAt: now,
		expiresAt: earliestSecretExpiresAt(entryExpiresAt, bucket.expires_at),
		placement: placementAfter,
	})
}

export async function updateUserSecretForPackage(input: {
	env: SecretWriteEnv
	userId: OwnerId
	userEmail?: string | null
	packageId: string
	name: string
	value: string
	description?: string | null
	waitUntil?: (promise: Promise<unknown>) => void
}) {
	const [saved] = await updateUserSecretsForPackageAtomically({
		env: input.env,
		userId: input.userId,
		userEmail: input.userEmail,
		packageId: input.packageId,
		secrets: [
			{
				name: input.name,
				value: input.value,
				description: input.description,
			},
		],
		waitUntil: input.waitUntil,
	})
	if (!saved) {
		throw new Error(
			`User secret "${input.name.trim()}" no longer exists or is not approved for package "${input.packageId.trim()}".`,
		)
	}
	return saved
}

/**
 * Persist multiple secrets in one D1 batch. Callers that rotate OAuth refresh
 * tokens must pass the refresh-token entry before the access-token entry.
 * Package contexts must call `assertCanSetSecrets` before any provider request
 * that consumes a rotating refresh token; the package write path also
 * fail-closes in SQL if any secret lacks the grant.
 */
export async function setSecretsAtomically(input: {
	env: SecretWriteEnv
	userId: OwnerId
	userEmail?: string | null
	secrets: Array<{
		name: string
		value: string
		scope: SecretScope
		description?: string | null
		expiresAt?: string | null
	}>
	storageContext?: StorageContext | null
	waitUntil?: (promise: Promise<unknown>) => void
}): Promise<Array<SecretMetadata>> {
	if (input.secrets.length === 0) {
		throw new Error('At least one secret is required.')
	}

	const storageContext = input.storageContext ?? null
	const packageId = storageContext?.packageId?.trim() ?? ''
	const scopes = new Set(input.secrets.map((secret) => secret.scope))
	if (scopes.size !== 1) {
		throw new Error('Atomic secret writes must share a single scope.')
	}
	const scope = input.secrets[0]?.scope
	if (!scope) {
		throw new Error('At least one secret is required.')
	}

	if (scope === 'user' && packageId) {
		if (input.secrets.some((secret) => secret.expiresAt !== undefined)) {
			throw new McpCallerError(
				'Package runtimes cannot change user secret expiry. Set expires_at from the account page or secretSet outside a package.',
			)
		}
		for (const secret of input.secrets) {
			const name = secret.name.trim()
			if (!name) throw new Error('Secret name is required.')
			const existing = await resolveSecret({
				env: input.env,
				userId: input.userId,
				name,
				scope: 'user',
				storageContext,
			})
			if (!existing.found) {
				throw new McpCallerError(
					'Package runtimes cannot create user-scoped secrets. Create the secret from the account page and approve the package first.',
				)
			}
		}
		return updateUserSecretsForPackageAtomically({
			env: input.env,
			userId: input.userId,
			userEmail: input.userEmail,
			packageId,
			secrets: input.secrets.map((secret) => ({
				name: secret.name,
				value: secret.value,
				description: secret.description,
			})),
			waitUntil: input.waitUntil,
		})
	}

	return saveSecretsAtomically({
		env: input.env,
		userId: input.userId,
		userEmail: input.userEmail,
		scope,
		secrets: input.secrets.map((secret) => ({
			name: secret.name,
			value: secret.value,
			description: secret.description,
			expiresAt: secret.expiresAt,
		})),
		storageContext,
		waitUntil: input.waitUntil,
	})
}

export async function updateUserSecretsForPackageAtomically(input: {
	env: SecretWriteEnv
	userId: OwnerId
	userEmail?: string | null
	packageId: string
	secrets: Array<{
		name: string
		value: string
		description?: string | null
	}>
	waitUntil?: (promise: Promise<unknown>) => void
}): Promise<Array<SecretMetadata>> {
	const packageId = input.packageId.trim()
	if (!packageId) throw new Error('Package id is required.')
	if (input.secrets.length === 0) {
		throw new Error('At least one secret is required.')
	}

	const bucket = await getExistingBucketForScope({
		db: input.env.APP_DB,
		userId: input.userId,
		scope: 'user',
		storageContext: null,
	})
	if (!bucket) throw new Error('User secret not found.')

	const now = new Date().toISOString()
	const prepared: Array<{
		name: string
		description: string
		encryptedValue: string
		existingEntry: NonNullable<Awaited<ReturnType<typeof getSecretEntry>>>
	}> = []
	let requestedStorageBytes = 0

	for (const secret of input.secrets) {
		const name = secret.name.trim()
		if (!name) throw new Error('Secret name is required.')
		assertSecretNameAllowed(name)
		const value = secret.value.trim()
		if (!value) throw new Error('Secret value is required.')
		const existingEntry = await getSecretEntry({
			db: input.env.APP_DB,
			bucketId: bucket.id,
			name,
		})
		if (!existingEntry) throw new Error('User secret not found.')
		assertValueFitsStoredKind(existingEntry, value)
		const description = secret.description?.trim() ?? existingEntry.description
		const encryptedValue = await encryptSecretValue(
			input.env,
			value,
			userSecretContext(input.userId),
		)
		requestedStorageBytes += estimateEntitlementStorageEntryByteDelta({
			next: {
				key: name,
				value: {
					description,
					encryptedValue,
					allowedHosts: existingEntry.allowed_hosts,
					allowedPackages: existingEntry.allowed_packages,
				},
			},
			existing: {
				key: existingEntry.name,
				value: {
					description: existingEntry.description,
					encryptedValue: existingEntry.encrypted_value,
					allowedHosts: existingEntry.allowed_hosts,
					allowedPackages: existingEntry.allowed_packages,
				},
			},
		})
		prepared.push({ name, description, encryptedValue, existingEntry })
	}

	await assertWithinStorageBytesEntitlement({
		db: input.env.APP_DB,
		env: input.env,
		userId: input.userId,
		email: input.userEmail,
		requested: requestedStorageBytes,
	})

	try {
		await updateApprovedUserSecretEntriesForPackageAtomically({
			db: input.env.APP_DB,
			userId: input.userId,
			packageId,
			updates: prepared.map((entry) => ({
				name: entry.name,
				description: entry.description,
				encryptedValue: entry.encryptedValue,
				updatedAt: now,
			})),
		})
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		if (message.includes('package cannot mutate one or more secrets')) {
			const names = prepared.map((entry) => entry.name).join(', ')
			throw new Error(
				`User secret(s) "${names}" no longer exist or are not approved for package "${packageId}".`,
			)
		}
		throw error
	}

	for (const entry of prepared) {
		let previousPlaintext: string | null = null
		try {
			previousPlaintext = await decryptSecretValue(
				input.env,
				entry.existingEntry.encrypted_value,
				userSecretContext(input.userId),
			)
		} catch {
			continue
		}
		const nextValue = input.secrets.find(
			(secret) => secret.name.trim() === entry.name,
		)?.value
		if (!nextValue || previousPlaintext === nextValue.trim()) continue
		await rotateWebhookHmacSecretsForSecretValueChange({
			env: input.env,
			userId: input.userId,
			secretName: entry.name,
			previousPlaintext,
			nextPlaintext: nextValue.trim(),
			now,
		})
	}

	return prepared.map((entry) =>
		toSecretMetadata({
			name: entry.name,
			scope: 'user',
			description: entry.description,
			packageId: null,
			allowedHosts: parseAllowedHosts(entry.existingEntry.allowed_hosts),
			allowedPackages: parseAllowedPackages(
				entry.existingEntry.allowed_packages,
			),
			createdAt: entry.existingEntry.created_at,
			updatedAt: now,
			expiresAt: earliestSecretExpiresAt(
				entry.existingEntry.expires_at,
				bucket.expires_at,
			),
			placement: readCredentialFillPlacement(
				entry.existingEntry.placement_json,
			),
		}),
	)
}

async function saveSecretsAtomically(input: {
	env: SecretWriteEnv
	userId: OwnerId
	userEmail?: string | null
	scope: SecretScope
	secrets: Array<{
		name: string
		value: string
		description?: string | null
		expiresAt?: string | null
	}>
	storageContext?: StorageContext | null
	waitUntil?: (promise: Promise<unknown>) => void
}): Promise<Array<SecretMetadata>> {
	const bucket = await getOrCreateSecretBucket({
		db: input.env.APP_DB,
		userId: input.userId,
		scope: input.scope,
		storageContext: input.storageContext ?? null,
		sessionExpiresAt: null,
	})
	const now = new Date().toISOString()
	const prepared: Array<{
		name: string
		description: string
		encryptedValue: string
		expiresAt: string | null
		existingEntry: Awaited<ReturnType<typeof getSecretEntry>>
	}> = []
	let newSecretCount = 0
	let requestedStorageBytes = 0

	for (const secret of input.secrets) {
		const name = secret.name.trim()
		if (!name) throw new Error('Secret name is required.')
		assertSecretNameAllowed(name)
		const value = secret.value.trim()
		if (!value) throw new Error('Secret value is required.')
		const description = secret.description?.trim() ?? ''
		const existingEntry = await getSecretEntry({
			db: input.env.APP_DB,
			bucketId: bucket.id,
			name,
		})
		assertValueFitsStoredKind(existingEntry, value)
		if (existingEntry == null) {
			newSecretCount += 1
		}
		const encryptedValue = await encryptSecretValue(
			input.env,
			value,
			userSecretContext(input.userId),
		)
		requestedStorageBytes += estimateEntitlementStorageEntryByteDelta({
			next: {
				key: name,
				value: {
					description,
					encryptedValue,
					allowedHosts: existingEntry?.allowed_hosts ?? '[]',
					allowedPackages: existingEntry?.allowed_packages ?? '[]',
				},
			},
			existing: existingEntry
				? {
						key: existingEntry.name,
						value: {
							description: existingEntry.description,
							encryptedValue: existingEntry.encrypted_value,
							allowedHosts: existingEntry.allowed_hosts,
							allowedPackages: existingEntry.allowed_packages,
						},
					}
				: null,
		})
		prepared.push({
			name,
			description,
			encryptedValue,
			expiresAt: nextSecretExpiresAt({
				existing: existingEntry?.expires_at,
				requested: secret.expiresAt,
			}),
			existingEntry,
		})
	}

	if (newSecretCount > 0) {
		await assertWithinEntitlement({
			db: input.env.APP_DB,
			userId: input.userId,
			email: input.userEmail,
			resource: 'secrets',
			requested: newSecretCount,
		})
	}
	await assertWithinStorageBytesEntitlement({
		db: input.env.APP_DB,
		env: input.env,
		userId: input.userId,
		email: input.userEmail,
		requested: requestedStorageBytes,
	})

	await upsertSecretEntriesAtomically({
		db: input.env.APP_DB,
		rows: prepared.map((entry) => ({
			bucket_id: bucket.id,
			name: entry.name,
			description: entry.description,
			encrypted_value: entry.encryptedValue,
			allowed_hosts: entry.existingEntry?.allowed_hosts ?? '[]',
			allowed_packages: entry.existingEntry?.allowed_packages ?? '[]',
			expires_at: entry.expiresAt,
			created_at: entry.existingEntry?.created_at ?? now,
			updated_at: now,
		})),
	})
	if (input.scope === 'user' || input.scope === 'package') {
		for (const entry of prepared) {
			if (!entry.existingEntry) continue
			const nextValue = input.secrets.find(
				(secret) => secret.name.trim() === entry.name,
			)?.value
			if (!nextValue) continue
			let previousPlaintext: string | null = null
			try {
				previousPlaintext = await decryptSecretValue(
					input.env,
					entry.existingEntry.encrypted_value,
					userSecretContext(input.userId),
				)
			} catch {
				continue
			}
			const trimmedNext = nextValue.trim()
			if (previousPlaintext === trimmedNext) continue
			await rotateWebhookHmacSecretsForSecretValueChange({
				env: input.env,
				userId: input.userId,
				secretName: entry.name,
				previousPlaintext,
				nextPlaintext: trimmedNext,
				now,
				...(input.scope === 'package' ? { packageId: bucket.binding_key } : {}),
			})
		}
	}
	if (input.scope === 'user' && newSecretCount > 0) {
		await stampFirstSecret(
			input.env.APP_DB,
			{ stableUserId: input.userId, at: now },
			input.env,
		)
	}

	return prepared.map((entry) =>
		toSecretMetadata({
			name: entry.name,
			scope: input.scope,
			description: entry.description,
			packageId: input.scope === 'package' ? bucket.binding_key : null,
			allowedHosts: entry.existingEntry
				? parseAllowedHosts(entry.existingEntry.allowed_hosts)
				: [],
			allowedPackages: entry.existingEntry
				? parseAllowedPackages(entry.existingEntry.allowed_packages)
				: [],
			createdAt: entry.existingEntry?.created_at ?? now,
			updatedAt: now,
			expiresAt: earliestSecretExpiresAt(entry.expiresAt, bucket.expires_at),
			placement: entry.existingEntry
				? readCredentialFillPlacement(entry.existingEntry.placement_json)
				: defaultNewCredentialFillPlacement,
		}),
	)
}

export async function listSecrets(
	input: ListSecretsInput,
): Promise<Array<ListedSecret>> {
	const buckets = await getAccessibleBuckets({
		db: input.env.APP_DB,
		userId: input.userId,
		scope: input.scope ?? null,
		storageContext: input.storageContext ?? null,
	})
	const results = await Promise.all(
		buckets.map((bucket) =>
			listSecretMetadataForBucket({
				db: input.env.APP_DB,
				bucket,
			}),
		),
	)
	const listed = results
		.flat()
		.filter((row) => !isReservedSecretName(row.name))
		.map((row) => ({
			credentialId: row.id,
			...toSecretMetadata({
				name: row.name,
				scope: row.scope,
				description: row.description,
				packageId: row.scope === 'package' ? row.binding_key : null,
				allowedHosts: parseAllowedHosts(row.allowed_hosts),
				allowedPackages: parseAllowedPackages(row.allowed_packages),
				createdAt: row.created_at,
				updatedAt: row.updated_at,
				expiresAt: row.expires_at,
				placement: readCredentialFillPlacement(row.placement_json),
			}),
		}))
	return listed
}

export type FoundSecret = Omit<ResolvedSecret, 'value'>

async function findSecretEntry(input: ResolveSecretInput) {
	assertSecretNameAllowed(input.name)
	const scopes = input.scope
		? [input.scope]
		: resolveSecretScopeOrder(input.storageContext ?? null)
	const scopeResults = await Promise.allSettled(
		scopes.map(async (scope) => {
			const bucket = await getExistingBucketForScope({
				db: input.env.APP_DB,
				userId: input.userId,
				scope,
				storageContext: input.storageContext ?? null,
			})
			if (!bucket) return null
			const entry = await getSecretEntry({
				db: input.env.APP_DB,
				bucketId: bucket.id,
				name: input.name,
			})
			if (!entry) return null
			if (!input.includeExpired && isSecretExpired(entry.expires_at)) {
				return null
			}
			return { scope, entry }
		}),
	)
	// Preserve sequential precedence semantics: a lower-precedence failure must
	// not mask a higher-precedence hit, and a failure at the winning scope still
	// surfaces as an error.
	for (const result of scopeResults) {
		if (result.status === 'rejected') throw result.reason
		if (result.value) return result.value
	}
	return null
}

/**
 * Whether a secret exists, and its scope and allowlists, without decrypting
 * the value. Existence and policy checks use this; only `resolveCredential`
 * and account management read values.
 */
export async function findSecret(
	input: ResolveSecretInput,
): Promise<FoundSecret> {
	const found = await findSecretEntry(input)
	if (!found) {
		return {
			found: false,
			credentialId: null,
			scope: null,
			allowedHosts: [],
			allowedPackages: [],
			placement: null,
		}
	}
	return {
		found: true,
		credentialId: found.entry.id,
		scope: found.scope,
		allowedHosts: parseAllowedHosts(found.entry.allowed_hosts),
		allowedPackages: parseAllowedPackages(found.entry.allowed_packages),
		placement: readCredentialFillPlacement(found.entry.placement_json),
	}
}

/**
 * One lookup for `resolveCredential`: the metadata it authorizes on, and a
 * `readValue` that decrypts only when the door calls it after authorizing.
 * Only a `secret` is found: a later kind places its own value through its
 * resolver, so a placeholder never fills it.
 */
export async function findSecretForUse(input: ResolveSecretInput): Promise<{
	found: FoundSecret
	readValue: () => Promise<ResolvedSecret>
}> {
	const found = await findSecretEntry(input)
	if (!found || found.entry.kind !== 'secret') {
		const missing: ResolvedSecret = {
			found: false,
			credentialId: null,
			value: null,
			scope: null,
			allowedHosts: [],
			allowedPackages: [],
			placement: null,
		}
		const { value: _value, ...metadata } = missing
		return { found: metadata, readValue: async () => missing }
	}
	const metadata: FoundSecret = {
		found: true,
		credentialId: found.entry.id,
		scope: found.scope,
		allowedHosts: parseAllowedHosts(found.entry.allowed_hosts),
		allowedPackages: parseAllowedPackages(found.entry.allowed_packages),
		placement: readCredentialFillPlacement(found.entry.placement_json),
	}
	return {
		found: metadata,
		readValue: async () => ({
			...metadata,
			value: await decryptSecretValue(
				input.env,
				found.entry.encrypted_value,
				userSecretContext(input.userId),
			),
		}),
	}
}

export type StoredCredential = {
	credentialId: string
	name: string
	kind: StoredCredentialKind
	allowedHosts: Array<string>
	/** Raw `inject_json`: how the credential's value or session is placed. */
	injectJson: string
	/** Raw `config_json`: a login credential's exchange, else null. */
	configJson: string | null
	/** Null means anywhere (placeholders / credential() may fill any part). */
	placement: CredentialFillPlacement | null
	/**
	 * Digest of the stored ciphertext and `config_json`. Every value write
	 * re-encrypts with a fresh IV, so any change to the value or exchange
	 * changes it.
	 */
	revision: string
}

/**
 * A stored credential by id for a later-kind resolver: its metadata, and a
 * `readValue` that decrypts only when the door calls it after authorizing.
 * Null when `ownerId` has no live, unexpired user-scope or package-bound
 * entry with that id.
 */
export async function findStoredCredentialForUse(input: {
	env: Pick<Env, 'APP_DB' | 'SECRET_STORE_KEY'>
	ownerId: OwnerId
	credentialId: string
}): Promise<{
	found: StoredCredential
	readValue: () => Promise<string>
} | null> {
	const row = await getStoredCredentialEntry({
		db: input.env.APP_DB,
		ownerId: input.ownerId,
		credentialId: input.credentialId,
	})
	if (!row) return null
	return {
		found: {
			credentialId: row.id,
			name: row.name,
			kind: row.kind,
			allowedHosts: parseAllowedHosts(row.allowed_hosts),
			injectJson: row.inject_json,
			configJson: row.config_json,
			placement: readCredentialFillPlacement(row.placement_json),
			revision: await sha256Hex(
				JSON.stringify([row.encrypted_value, row.config_json]),
			),
		},
		readValue: () =>
			decryptSecretValue(
				input.env,
				row.encrypted_value,
				userSecretContext(input.ownerId),
			),
	}
}

export async function resolveSecret(
	input: ResolveSecretInput,
): Promise<ResolvedSecret> {
	const found = await findSecretEntry(input)
	if (!found) {
		return {
			found: false,
			credentialId: null,
			value: null,
			scope: null,
			allowedHosts: [],
			allowedPackages: [],
			placement: null,
		}
	}
	return {
		found: true,
		credentialId: found.entry.id,
		value: await decryptSecretValue(
			input.env,
			found.entry.encrypted_value,
			userSecretContext(input.userId),
		),
		scope: found.scope,
		allowedHosts: parseAllowedHosts(found.entry.allowed_hosts),
		allowedPackages: parseAllowedPackages(found.entry.allowed_packages),
		placement: readCredentialFillPlacement(found.entry.placement_json),
	}
}

export async function deleteSecret(input: DeleteSecretInput) {
	assertSecretNameAllowed(input.name)
	const bucket = await getExistingBucketForScope({
		db: input.env.APP_DB,
		userId: input.userId,
		scope: input.scope,
		storageContext: input.storageContext ?? null,
	})
	if (!bucket) return false
	return deleteSecretEntry({
		db: input.env.APP_DB,
		userId: input.userId,
		bucketId: bucket.id,
		name: input.name,
	})
}

/**
 * Rename a secret in its current scope/binding without changing its credential
 * id. Matching is case-sensitive (same as resolve/list), so Henry → henry is a
 * real rename. Throws when the source is missing or the destination is taken.
 */
export async function renameSecret(input: {
	env: Pick<Env, 'APP_DB'>
	userId: OwnerId
	scope: SecretScope
	fromName: string
	toName: string
	storageContext?: StorageContext | null
}): Promise<SecretMetadata> {
	const fromName = input.fromName.trim()
	const toName = input.toName.trim()
	if (!fromName || !toName) {
		throw new Error('Secret name is required.')
	}
	assertSecretNameAllowed(fromName)
	assertSecretNameAllowed(toName)
	const bucket = await getExistingBucketForScope({
		db: input.env.APP_DB,
		userId: input.userId,
		scope: input.scope,
		storageContext: input.storageContext ?? null,
	})
	if (!bucket) {
		throw new Error('Secret not found for this scope.')
	}
	const existing = await getSecretEntry({
		db: input.env.APP_DB,
		bucketId: bucket.id,
		name: fromName,
	})
	if (!existing) {
		throw new Error('Secret not found for this scope.')
	}
	if (fromName === toName) {
		return toSecretMetadata({
			name: fromName,
			scope: input.scope,
			description: existing.description,
			packageId: input.scope === 'package' ? bucket.binding_key : null,
			allowedHosts: parseAllowedHosts(existing.allowed_hosts),
			allowedPackages: parseAllowedPackages(existing.allowed_packages),
			createdAt: existing.created_at,
			updatedAt: existing.updated_at,
			expiresAt: earliestSecretExpiresAt(
				existing.expires_at,
				bucket.expires_at,
			),
			placement: readCredentialFillPlacement(existing.placement_json),
		})
	}
	const taken = await getSecretEntry({
		db: input.env.APP_DB,
		bucketId: bucket.id,
		name: toName,
	})
	if (taken) {
		throw new Error('A secret with that name and scope already exists.')
	}
	const now = new Date().toISOString()
	const renamed = await renameSecretEntry({
		db: input.env.APP_DB,
		bucketId: bucket.id,
		fromName,
		toName,
		updatedAt: now,
	})
	if (!renamed) {
		throw new Error('Secret not found for this scope.')
	}
	const updated = await getSecretEntry({
		db: input.env.APP_DB,
		bucketId: bucket.id,
		name: toName,
	})
	if (!updated || updated.name !== toName) {
		throw new Error('Secret rename did not persist the new name.')
	}
	return toSecretMetadata({
		name: updated.name,
		scope: input.scope,
		description: updated.description,
		packageId: input.scope === 'package' ? bucket.binding_key : null,
		allowedHosts: parseAllowedHosts(updated.allowed_hosts),
		allowedPackages: parseAllowedPackages(updated.allowed_packages),
		createdAt: updated.created_at,
		updatedAt: updated.updated_at,
		expiresAt: earliestSecretExpiresAt(updated.expires_at, bucket.expires_at),
		placement: readCredentialFillPlacement(updated.placement_json),
	})
}

/** A secret's metadata without writing it; throws when it does not exist. */
export async function readSecretMetadata(
	input: SecretOwnerContext & {
		env: Pick<Env, 'APP_DB'>
		name: string
		scope: SecretScope
	},
): Promise<SecretMetadata> {
	const name = input.name.trim()
	const bucket = await getExistingBucketForScope({
		db: input.env.APP_DB,
		userId: input.userId,
		scope: input.scope,
		storageContext: input.storageContext ?? null,
	})
	const entry = bucket
		? await getSecretEntry({ db: input.env.APP_DB, bucketId: bucket.id, name })
		: null
	if (!bucket || !entry) {
		throw new Error('Secret not found for this scope.')
	}
	return toSecretMetadata({
		name,
		scope: input.scope,
		description: entry.description,
		packageId: input.scope === 'package' ? bucket.binding_key : null,
		allowedHosts: parseAllowedHosts(entry.allowed_hosts),
		allowedPackages: parseAllowedPackages(entry.allowed_packages),
		createdAt: entry.created_at,
		updatedAt: entry.updated_at,
		expiresAt: earliestSecretExpiresAt(entry.expires_at, bucket.expires_at),
		placement: readCredentialFillPlacement(entry.placement_json),
	})
}

export async function updateSecret(
	input: UpdateSecretInput,
): Promise<SecretMetadata> {
	const name = input.name.trim()
	if (!name) {
		throw new Error('Secret name is required.')
	}
	assertSecretNameAllowed(name)
	const bucket = await getExistingBucketForScope({
		db: input.env.APP_DB,
		userId: input.userId,
		scope: input.scope,
		storageContext: input.storageContext ?? null,
	})
	if (!bucket) {
		throw new Error('Secret not found for this scope.')
	}
	const existingEntry = await getSecretEntry({
		db: input.env.APP_DB,
		bucketId: bucket.id,
		name,
	})
	if (!existingEntry) {
		throw new Error('Secret not found for this scope.')
	}
	const nextDescription =
		input.description == null
			? existingEntry.description
			: input.description.trim()
	const hasValueUpdate = input.value != null
	const nextValue = input.value?.trim() ?? null
	if (
		!hasValueUpdate &&
		input.description == null &&
		input.expiresAt === undefined
	) {
		throw new Error(
			'Provide a new secret value, description, or expires_at to update.',
		)
	}
	if (hasValueUpdate && !nextValue) {
		throw new Error('Secret value must not be empty.')
	}
	if (nextValue) assertValueFitsStoredKind(existingEntry, nextValue)
	let previousPlaintext: string | null = null
	if (hasValueUpdate) {
		try {
			previousPlaintext = await decryptSecretValue(
				input.env,
				existingEntry.encrypted_value,
				userSecretContext(input.userId),
			)
		} catch {
			previousPlaintext = null
		}
	}
	const now = new Date().toISOString()
	const entryExpiresAt = nextSecretExpiresAt({
		existing: existingEntry.expires_at,
		requested: input.expiresAt,
	})
	await upsertSecretEntry({
		db: input.env.APP_DB,
		row: {
			bucket_id: bucket.id,
			name,
			description: nextDescription,
			encrypted_value: hasValueUpdate
				? await encryptSecretValue(
						input.env,
						nextValue!,
						userSecretContext(input.userId),
					)
				: existingEntry.encrypted_value,
			allowed_hosts: existingEntry.allowed_hosts,
			allowed_packages: existingEntry.allowed_packages,
			expires_at: entryExpiresAt,
			created_at: existingEntry.created_at,
			updated_at: now,
		},
	})
	if (
		hasValueUpdate &&
		previousPlaintext !== null &&
		previousPlaintext !== nextValue &&
		(input.scope === 'user' || input.scope === 'package')
	) {
		await rotateWebhookHmacSecretsForSecretValueChange({
			env: input.env,
			userId: input.userId,
			secretName: name,
			previousPlaintext,
			nextPlaintext: nextValue!,
			now,
			...(input.scope === 'package' ? { packageId: bucket.binding_key } : {}),
		})
	}
	return toSecretMetadata({
		name,
		scope: input.scope,
		description: nextDescription,
		packageId: input.scope === 'package' ? bucket.binding_key : null,
		allowedHosts: parseAllowedHosts(existingEntry.allowed_hosts),
		allowedPackages: parseAllowedPackages(existingEntry.allowed_packages),
		createdAt: existingEntry.created_at,
		updatedAt: now,
		expiresAt: earliestSecretExpiresAt(entryExpiresAt, bucket.expires_at),
		placement: readCredentialFillPlacement(existingEntry.placement_json),
	})
}

export async function listUserSecretsForSearch(input: {
	env: Pick<Env, 'APP_DB'>
	userId: OwnerId
}) {
	const rows = await listUserScopeSecretMetadata({
		db: input.env.APP_DB,
		userId: input.userId,
	})
	return rows
		.filter((row) => !isReservedSecretName(row.name))
		.map((row) => ({
			credentialId: row.id,
			name: row.name,
			scope: row.scope,
			description: row.description,
			packageId: null,
			updatedAt: row.updated_at,
		}))
}

export async function listPackageSecretsByPackageIds(input: {
	env: Pick<Env, 'APP_DB'>
	userId: OwnerId
	packageIds: Array<string>
}) {
	const rows = await listPackageScopeSecretMetadata({
		db: input.env.APP_DB,
		userId: input.userId,
		packageIds: input.packageIds,
	})
	const grouped = new Map<string, Array<SecretMetadata>>()
	for (const row of rows) {
		if (isReservedSecretName(row.name)) continue
		const packageId = row.binding_key
		const current = grouped.get(packageId) ?? []
		current.push(
			toSecretMetadata({
				name: row.name,
				scope: row.scope,
				description: row.description,
				packageId,
				allowedHosts: parseAllowedHosts(row.allowed_hosts),
				allowedPackages: parseAllowedPackages(row.allowed_packages),
				createdAt: row.created_at,
				updatedAt: row.updated_at,
				expiresAt: row.expires_at,
				placement: readCredentialFillPlacement(row.placement_json),
			}),
		)
		grouped.set(packageId, current)
	}
	return grouped
}

async function getAccessibleBuckets(input: {
	db: D1Database
	userId: OwnerId
	scope: SecretScope | null
	storageContext: StorageContext | null
}) {
	const scopes = input.scope
		? [input.scope]
		: resolveSecretListScopeOrder(input.storageContext)
	const buckets = await Promise.all(
		scopes.map((scope) =>
			listAccessibleBucketsForScope({
				db: input.db,
				userId: input.userId,
				scope,
				storageContext: input.storageContext,
			}),
		),
	)
	return buckets.flat()
}

async function listAccessibleBucketsForScope(input: {
	db: D1Database
	userId: OwnerId
	scope: SecretScope
	storageContext: StorageContext | null
}) {
	if (
		input.scope === 'package' &&
		getSecretBindingKey('package', input.storageContext) == null
	) {
		// Listing-only: discover caller-owned package buckets without a
		// package runtime binding. Resolve/use still go through
		// getExistingBucketForScope and require packageId.
		return listSecretBucketsByScope({
			db: input.db,
			userId: input.userId,
			scope: 'package',
		})
	}
	const bucket = await getExistingBucketForScope(input)
	return bucket ? [bucket] : []
}

async function getExistingBucketForScope(input: {
	db: D1Database
	userId: OwnerId
	scope: SecretScope
	storageContext: StorageContext | null
}) {
	const bindingKey = getSecretBindingKey(input.scope, input.storageContext)
	if (bindingKey == null) return null
	return getSecretBucket({
		db: input.db,
		userId: input.userId,
		scope: input.scope,
		bindingKey,
	})
}

async function getOrCreateSecretBucket(input: {
	db: D1Database
	userId: OwnerId
	scope: SecretScope
	storageContext: StorageContext | null
	sessionExpiresAt: string | null
}) {
	const bindingKey = getSecretBindingKey(input.scope, input.storageContext)
	if (bindingKey == null) {
		// Caller asked for session/package scope without that binding in the
		// current storage context. Keep it off Sentry via McpCallerError.
		throw new McpCallerError(
			`Secret scope "${input.scope}" is unavailable in this context.`,
		)
	}
	const existing = await getSecretBucket({
		db: input.db,
		userId: input.userId,
		scope: input.scope,
		bindingKey,
	})
	if (existing) {
		const nextExpiresAt =
			input.scope === 'session'
				? (input.sessionExpiresAt ?? existing.expires_at)
				: null
		if (existing.expires_at !== nextExpiresAt) {
			await upsertSecretBucket({
				db: input.db,
				row: {
					...existing,
					expires_at: nextExpiresAt,
				},
			})
			return {
				...existing,
				expires_at: nextExpiresAt,
				updated_at: new Date().toISOString(),
			}
		}
		return existing
	}
	const now = new Date().toISOString()
	const created = {
		id: crypto.randomUUID(),
		user_id: input.userId,
		scope: input.scope,
		binding_key: bindingKey,
		expires_at:
			input.scope === 'session' ? (input.sessionExpiresAt ?? null) : null,
		created_at: now,
		updated_at: now,
	}
	await upsertSecretBucket({
		db: input.db,
		row: created,
	})
	return created
}

function toSecretMetadata(input: {
	name: string
	scope: SecretScope
	description: string
	packageId: string | null
	allowedHosts: Array<string>
	allowedPackages: Array<string>
	createdAt: string
	updatedAt: string
	expiresAt: string | null
	placement?: CredentialFillPlacement | null
}): SecretMetadata {
	return {
		name: input.name,
		scope: input.scope,
		description: input.description,
		packageId: input.packageId,
		allowedHosts: normalizeAllowedHosts(input.allowedHosts),
		allowedPackages: normalizeAllowedPackages(input.allowedPackages),
		createdAt: input.createdAt,
		updatedAt: input.updatedAt,
		expiresAt: input.expiresAt,
		ttlMs: secretTtlMs(input.expiresAt),
		placement: input.placement === undefined ? null : input.placement,
	}
}

export async function setSecretAllowedHosts(input: {
	env: Pick<Env, 'APP_DB'>
	userId: OwnerId
	name: string
	scope: SecretScope
	allowedHosts: Array<string>
	storageContext?: StorageContext | null
}) {
	const name = input.name.trim()
	if (!name) {
		throw new Error('Secret name is required.')
	}
	assertSecretNameAllowed(name)
	const bucket = await getExistingBucketForScope({
		db: input.env.APP_DB,
		userId: input.userId,
		scope: input.scope,
		storageContext: input.storageContext ?? null,
	})
	if (!bucket) {
		throw new Error('Secret not found for this scope.')
	}
	const existingEntry = await getSecretEntry({
		db: input.env.APP_DB,
		bucketId: bucket.id,
		name,
	})
	if (!existingEntry) {
		throw new Error('Secret not found for this scope.')
	}
	const now = new Date().toISOString()
	await upsertSecretEntry({
		db: input.env.APP_DB,
		row: {
			...existingEntry,
			allowed_hosts: stringifyAllowedHosts(input.allowedHosts),
			updated_at: now,
		},
	})
	return toSecretMetadata({
		name,
		scope: input.scope,
		description: existingEntry.description,
		packageId: input.scope === 'package' ? bucket.binding_key : null,
		allowedHosts: input.allowedHosts,
		allowedPackages: parseAllowedPackages(existingEntry.allowed_packages),
		createdAt: existingEntry.created_at,
		updatedAt: now,
		expiresAt: earliestSecretExpiresAt(
			existingEntry.expires_at,
			bucket.expires_at,
		),
		placement: readCredentialFillPlacement(existingEntry.placement_json),
	})
}

export async function setSecretAllowedPackages(input: {
	env: Pick<Env, 'APP_DB'>
	userId: OwnerId
	name: string
	scope: SecretScope
	allowedPackages: Array<string>
	storageContext?: StorageContext | null
}) {
	if (input.scope !== 'user' && input.allowedPackages.length > 0) {
		throw new Error('Package approvals are only supported for user secrets.')
	}
	const name = input.name.trim()
	if (!name) {
		throw new Error('Secret name is required.')
	}
	assertSecretNameAllowed(name)
	const bucket = await getExistingBucketForScope({
		db: input.env.APP_DB,
		userId: input.userId,
		scope: input.scope,
		storageContext: input.storageContext ?? null,
	})
	if (!bucket) {
		throw new Error('Secret not found for this scope.')
	}
	const existingEntry = await getSecretEntry({
		db: input.env.APP_DB,
		bucketId: bucket.id,
		name,
	})
	if (!existingEntry) {
		throw new Error('Secret not found for this scope.')
	}
	const now = new Date().toISOString()
	await upsertSecretEntry({
		db: input.env.APP_DB,
		row: {
			...existingEntry,
			allowed_packages: stringifyAllowedPackages(input.allowedPackages),
			updated_at: now,
		},
	})
	return toSecretMetadata({
		name,
		scope: input.scope,
		description: existingEntry.description,
		packageId: input.scope === 'package' ? bucket.binding_key : null,
		allowedHosts: parseAllowedHosts(existingEntry.allowed_hosts),
		allowedPackages: input.allowedPackages,
		createdAt: existingEntry.created_at,
		updatedAt: now,
		expiresAt: earliestSecretExpiresAt(
			existingEntry.expires_at,
			bucket.expires_at,
		),
		placement: readCredentialFillPlacement(existingEntry.placement_json),
	})
}

type UserSecretPackageGrantState = {
	secret: SecretMetadata
	savedPackage: {
		id: string
		kodyId: string
	}
	alreadyGranted: boolean
}

/**
 * Read-only lookup for a user secret + saved package grant. Does not mutate
 * `allowed_packages`. MCP `secretLock` uses this; applying a grant is
 * website-only via `lockSecretToPackage` / `setSecretAllowedPackages`.
 */
export async function inspectUserSecretPackageGrant(input: {
	env: Pick<Env, 'APP_DB'>
	userId: OwnerId
	name: string
	packageId: string
}): Promise<UserSecretPackageGrantState> {
	const packageId = input.packageId.trim()
	if (!packageId) {
		throw new Error('Package id is required.')
	}
	const savedPackage = await getSavedPackageById(input.env.APP_DB, {
		userId: input.userId,
		packageId,
	})
	if (!savedPackage) {
		throw new Error('Saved package not found for this user.')
	}
	const bucket = await getExistingBucketForScope({
		db: input.env.APP_DB,
		userId: input.userId,
		scope: 'user',
		storageContext: null,
	})
	if (!bucket) {
		throw new Error('Secret not found for this scope.')
	}
	const existingEntry = await getSecretEntry({
		db: input.env.APP_DB,
		bucketId: bucket.id,
		name: input.name.trim(),
	})
	if (!existingEntry) {
		throw new Error('Secret not found for this scope.')
	}
	const currentPackages = parseAllowedPackages(existingEntry.allowed_packages)
	return {
		secret: toSecretMetadata({
			name: input.name.trim(),
			scope: 'user',
			description: existingEntry.description,
			packageId: null,
			allowedHosts: parseAllowedHosts(existingEntry.allowed_hosts),
			allowedPackages: currentPackages,
			createdAt: existingEntry.created_at,
			updatedAt: existingEntry.updated_at,
			expiresAt: earliestSecretExpiresAt(
				existingEntry.expires_at,
				bucket.expires_at,
			),
			placement: readCredentialFillPlacement(existingEntry.placement_json),
		}),
		savedPackage: {
			id: savedPackage.id,
			kodyId: savedPackage.kodyId,
		},
		alreadyGranted: currentPackages.includes(packageId),
	}
}

/**
 * Tighten-only package grant on a user secret. Adds `packageId` to
 * `allowed_packages`. Additional grants accumulate. Removing a grant is
 * website-only. User-scope only — package secrets do not have this grant.
 * Account secret editor and `/account/secrets/approve` apply grants through
 * `setSecretAllowedPackages` (or this helper). MCP `secretLock` must not.
 */
export async function lockSecretToPackage(input: {
	env: Pick<Env, 'APP_DB'>
	userId: OwnerId
	name: string
	packageId: string
}): Promise<SecretMetadata> {
	const state = await inspectUserSecretPackageGrant(input)
	if (state.alreadyGranted) {
		return state.secret
	}
	return setSecretAllowedPackages({
		env: input.env,
		userId: input.userId,
		name: input.name,
		scope: 'user',
		allowedPackages: [...state.secret.allowedPackages, state.savedPackage.id],
	})
}
