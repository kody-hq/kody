/**
 * Resolvers for stored secrets and vault references. Stored secrets check
 * the actor's Use, package rules, and host allowlist from metadata before the
 * value is decrypted. A vault item's hosts come back with its value, so the
 * vault checks Use on the binding first and the host after the read.
 */
import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { loadPersonalOrgIdForPerson } from '#worker/orgs/personal-org-id.ts'
import {
	assertPackageCanAccessResolvedSecret,
	loadPackageSecretMounts,
	PackageSecretMissingError,
	PackageSecretMountError,
} from '#mcp/secrets/package-access.ts'
import { SecretHostNotApprovedError } from '#mcp/secrets/errors.ts'
import { secretPageOrgSlugFromCaller } from '#mcp/secrets/package-approval-url.ts'
import { buildSecretPlaceholder } from '#mcp/secrets/placeholders.ts'
import {
	createProviderHostDeniedMessage,
	createProviderNoWebsitesMessage,
	SecretProviderHostDeniedError,
} from '#mcp/secrets/secret-providers/errors.ts'
import { providerHostsAllowRequestHost } from '#mcp/secrets/secret-providers/hosts.ts'
import { invokeSealedSecretProvider } from '#mcp/secrets/secret-providers/sealed-invoke.ts'
import {
	getSecretProviderBinding,
	normalizeProviderId,
	resolveProviderSecret,
} from '#mcp/secrets/secret-providers/service.ts'
import {
	findSecretForUse,
	type FoundSecret,
	type ResolvedSecret,
} from '#mcp/secrets/service.ts'
import { createUnresolvedSecretMessage } from '#mcp/secrets/unresolved-secret.ts'
import { type StorageContext } from '#mcp/storage.ts'
import { assertCredentialUsesDeclared } from './credential-need-enforcement.ts'
import {
	assertCredentialScopeAllows,
	authorizeActorUse,
	type CredentialResolver,
	type ResolverCall,
} from './credential-resolver.ts'
import { authorizePersonalCredentialUse } from './personal-credentials.ts'

function isFoundSecret(secret: ResolvedSecret) {
	return secret.found && typeof secret.value === 'string'
}

type SecretNameLookup = {
	owner: 'org' | 'personal'
	ownerId: OwnerId
	found: FoundSecret
	readValue: () => Promise<ResolvedSecret>
}

/** Org secret by name, else the actor's granted personal secret of that name. */
async function findSecretByName(
	call: ResolverCall,
	input: {
		name: string
		scope?: Parameters<typeof findSecretForUse>[0]['scope']
		storageContext: StorageContext
	},
): Promise<SecretNameLookup> {
	const orgLookup = await findSecretForUse({
		env: call.input.env,
		userId: call.input.orgId,
		name: input.name,
		scope: input.scope,
		storageContext: input.storageContext,
	})
	if (orgLookup.found.found) {
		return {
			owner: 'org',
			ownerId: call.input.orgId,
			found: orgLookup.found,
			readValue: orgLookup.readValue,
		}
	}
	const person = call.input.actor?.actor?.userId
	if (!person) {
		return {
			owner: 'org',
			ownerId: call.input.orgId,
			found: orgLookup.found,
			readValue: orgLookup.readValue,
		}
	}
	const personalOwner = await loadPersonalOrgIdForPerson(
		call.input.env.APP_DB,
		person,
	)
	const personalLookup = await findSecretForUse({
		env: call.input.env,
		userId: personalOwner,
		name: input.name,
		scope: input.scope,
		storageContext: input.storageContext,
	})
	if (personalLookup.found.found) {
		return {
			owner: 'personal',
			ownerId: personalOwner,
			found: personalLookup.found,
			readValue: personalLookup.readValue,
		}
	}
	return {
		owner: 'org',
		ownerId: call.input.orgId,
		found: orgLookup.found,
		readValue: orgLookup.readValue,
	}
}

async function authorizeSecretNameUse(
	call: ResolverCall,
	lookup: SecretNameLookup,
) {
	const { found } = lookup
	switch (lookup.owner) {
		case 'org':
			await authorizeActorUse(call, found.credentialId)
			break
		case 'personal':
			call.subject.credentialId = found.credentialId
			assertCredentialScopeAllows(call, 'secret:use')
			await authorizePersonalCredentialUse({
				db: call.input.env.APP_DB,
				actorPersonId: call.input.actor?.actor?.userId ?? null,
				orgId: call.input.orgId,
				credentialId: found.credentialId ?? '',
			})
			break
		default: {
			const exhaustive: never = lookup.owner
			throw new Error(`Unhandled secret owner: ${String(exhaustive)}`)
		}
	}
}

export const secretResolver: CredentialResolver<'secret'> = {
	auditSubject: (credential) => ({
		use: credential.use,
		resourceType: 'secret',
		name: credential.name,
		credentialId: null,
		details: { host: credential.requestHost ?? null },
	}),
	async resolve(call) {
		const { input, credential } = call
		const lookup = await findSecretByName(call, {
			name: credential.name,
			scope: credential.scope,
			storageContext: credential.storageContext,
		})
		const found = lookup.found
		return {
			async authorize() {
				await authorizeSecretNameUse(call, lookup)
				if (!found.found) return
				await assertPackageCanAccessResolvedSecret({
					env: input.env,
					baseUrl: input.baseUrl,
					orgSlug: credential.orgSlug,
					// Package allowlists and implicit personal-secret access live on
					// the credential's owning org (run org, or the actor's personal
					// org for a granted personal Key) — same as oauth-resolvers.
					userId: lookup.ownerId,
					storageContext: credential.storageContext,
					authorityPackageId: input.packageStamp?.packageId ?? null,
					secretName: credential.name,
					resolved: found,
				})
				if (
					credential.requestHost &&
					!found.allowedHosts.includes(credential.requestHost)
				) {
					throw new SecretHostNotApprovedError({
						secretName: credential.name,
						host: credential.requestHost,
						scope: found.scope ?? credential.scope ?? 'user',
					})
				}
			},
			apply: lookup.readValue,
		}
	},
	isFound: isFoundSecret,
}

export const webhookSecretResolver: CredentialResolver<'webhook-secret'> = {
	auditSubject: (credential) => ({
		use: credential.use,
		resourceType: 'secret',
		name: credential.name,
		credentialId: null,
	}),
	async resolve(call) {
		const { input, credential } = call
		// Every webhook belongs to a package, and the read is limited to secrets
		// that package may read, like placeholder and mount reads.
		const packageId = input.packageStamp?.packageId
		if (!packageId) {
			throw new Error('Webhook secrets resolve only for the webhook package.')
		}
		const storageContext = { sessionId: null, appId: null, packageId }
		const lookup = await findSecretForUse({
			env: input.env,
			userId: input.orgId,
			name: credential.name,
			storageContext,
		})
		const found = lookup.found
		return {
			async authorize() {
				await authorizeActorUse(call, found.credentialId)
				if (!found.found) return
				await assertPackageCanAccessResolvedSecret({
					env: input.env,
					baseUrl: input.baseUrl,
					userId: input.orgId,
					storageContext,
					authorityPackageId: packageId,
					secretName: credential.name,
					resolved: found,
				})
			},
			apply: lookup.readValue,
		}
	},
	isFound: isFoundSecret,
}

export const packageSecretMountResolver: CredentialResolver<'package-secret-mount'> =
	{
		// The mounted secret's name replaces the alias once the mount loads.
		auditSubject: (credential) => ({
			use: credential.use,
			resourceType: 'secret',
			name: credential.alias,
			credentialId: null,
			details: {
				mountAlias: credential.alias,
				access: credential.access ?? 'value',
			},
		}),
		async resolve(call) {
			const { input, credential, subject } = call
			const packageId = input.packageStamp?.packageId ?? ''
			if (!packageId) {
				throw new Error(
					'Package secret access requires a matching server-side package runtime context.',
				)
			}
			if (!input.orgId) {
				throw new Error(
					'Package secret access requires an authenticated package caller context.',
				)
			}
			const callerContext = credential.callerContext
			const packageInfo = await loadPackageSecretMounts({
				env: input.env,
				baseUrl: input.baseUrl,
				userId: input.orgId,
				packageId,
			})
			const mount = packageInfo.mounts[credential.alias]
			if (!mount) {
				throw new PackageSecretMountError(
					`Package "${packageInfo.savedPackage.kodyId}" does not declare secret mount "${credential.alias}".`,
				)
			}
			// The alias is not a stamp key. Once this package carries a credential
			// stamp, the mounted secret name must be a declared kody.credentials
			// slot (kind secret, signing, or omitted). A name that is not
			// declared fails closed. The mount's package or session scope does
			// not skip that check, and resolution still reads only the current
			// manifest's secretMounts.
			await assertCredentialUsesDeclared({
				env: input.env,
				request: input.actor,
				orgId: input.orgId,
				packageId,
				references: [{ use: 'secret', name: mount.name, scope: null }],
			})
			subject.name = mount.name
			const storageContext: StorageContext = {
				sessionId: callerContext.storageContext?.sessionId ?? null,
				appId: callerContext.storageContext?.appId ?? null,
				packageId,
				storageId: callerContext.storageContext?.storageId ?? null,
			}
			const lookup = await findSecretForUse({
				env: input.env,
				userId: input.orgId,
				name: mount.name,
				scope: mount.scope,
				storageContext,
			})
			const found = lookup.found
			const missing = async () =>
				new PackageSecretMissingError(
					await createUnresolvedSecretMessage({
						env: input.env,
						userId: input.orgId,
						name: mount.name,
						scope: mount.scope,
						storageContext,
						baseUrl: input.baseUrl,
					}),
				)
			// The placeholder carries name+scope only, never the owner id (that
			// would be caller-forgeable).
			const scope = found.scope ?? mount.scope ?? 'user'
			return {
				async authorize() {
					await authorizeActorUse(call, found.credentialId)
					if (!found.found) throw await missing()
					await assertPackageCanAccessResolvedSecret({
						env: input.env,
						baseUrl: input.baseUrl,
						orgSlug: secretPageOrgSlugFromCaller(callerContext),
						userId: input.orgId,
						storageContext,
						authorityPackageId: packageId,
						secretName: mount.name,
						resolved: found,
					})
				},
				async apply() {
					const access = credential.access ?? 'value'
					switch (access) {
						case 'presence':
							break
						case 'value': {
							// `.get` proves the stored value still decrypts; the value
							// itself stays on the host.
							const resolved = await lookup.readValue()
							if (!isFoundSecret(resolved)) throw await missing()
							break
						}
						default: {
							const exhaustive: never = access
							throw new Error(
								`Unhandled package secret access: ${String(exhaustive)}`,
							)
						}
					}
					return {
						alias: credential.alias,
						name: mount.name,
						ref: buildSecretPlaceholder({ name: mount.name, scope }),
						scope,
						packageId: packageInfo.savedPackage.id,
						kodyId: packageInfo.savedPackage.kodyId,
					}
				},
			}
		},
		isFound: () => true,
	}

export const vaultSecretResolver: CredentialResolver<'provider-secret'> = {
	auditSubject: (credential) => ({
		use: credential.use,
		resourceType: 'secret-provider',
		// Validated inside the audited resolve; building the subject must not throw.
		name: credential.provider.trim().toLowerCase(),
		credentialId: null,
		details: { host: credential.requestHost ?? null },
	}),
	async resolve(call) {
		const { input, credential } = call
		const request = input.actor
		if (!request) {
			throw new Error('Provider secrets require the fetching run request.')
		}
		const binding = await getSecretProviderBinding(input.env.APP_DB, {
			userId: input.orgId,
			providerId: normalizeProviderId(credential.provider),
		})
		return {
			// The binding is the credential: Use on it before any decrypt or
			// provider invoke. A missing binding is checked like any credential
			// that was not found, then fails inside resolveProviderSecret.
			async authorize() {
				await authorizeActorUse(call, binding?.credentialId ?? null)
			},
			async apply() {
				const resolved = await resolveProviderSecret({
					env: input.env,
					baseUrl: input.baseUrl,
					userId: input.orgId,
					request,
					provider: credential.provider,
					binding,
					ref: credential.ref,
					storageContext: credential.storageContext,
					// Claimed packages are held to their grants too; only Use differs.
					authorityPackageId: input.packageStamp?.packageId ?? null,
					invokeProvider: invokeSealedSecretProvider,
				})
				const host = credential.requestHost
				if (host) {
					if (resolved.hosts.length === 0) {
						throw new SecretProviderHostDeniedError(
							createProviderNoWebsitesMessage(resolved.provider),
						)
					}
					if (!providerHostsAllowRequestHost(resolved.hosts, host)) {
						throw new SecretProviderHostDeniedError(
							createProviderHostDeniedMessage({
								providerId: resolved.provider,
								host,
							}),
						)
					}
				}
				return resolved
			},
		}
	},
	isFound: () => true,
}
