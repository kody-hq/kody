import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import type { RequestContext } from '@kody-internal/shared/request-context.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import {
	decryptWebhookHmacSecret,
	encryptWebhookHmacSecret,
	userWebhookHmacSecretContext,
} from '#mcp/secrets/crypto.ts'
import { getAppBaseUrl } from '#worker/app-base-url.ts'
import { attestedPackageStamp } from '#worker/credentials/package-stamp.ts'
import { resolveCredential } from '#worker/credentials/resolve-credential.ts'
import type { PackageWebhookHmacVerificationEntry } from '#worker/package-registry/manifest.ts'
import { generateWebhookUrlSecret } from './crypto.ts'
import {
	decryptWebhookVerificationSnapshot,
	reconcileWebhookHmacVerificationRotation,
} from './hmac-rotation.ts'
import { setWebhookEndpointHmacVerificationState } from './repo.ts'
import {
	isWebhookPreviousHmacLive,
	type WebhookEndpointRecord,
} from './types.ts'

/**
 * Shape of the signing secret mint gives a webhook that declares no HMAC
 * scheme (url-secret or no verification): HMAC-SHA256 of the body, hex
 * encoded in `X-Kody-Signature` as `sha256=<hex>`. Ingress does not require
 * it; such webhooks are authenticated by their URL secret.
 */
export const defaultWebhookVerification = {
	type: 'hmac-sha256',
	header: 'x-kody-signature',
	encoding: 'hex',
	prefix: 'sha256=',
} as const satisfies PackageWebhookHmacVerificationEntry

/**
 * Package-owned HMAC plaintext for apply injection (`{{webhookSecret}}`).
 *
 * Apply reads only the ciphertext on the endpoint — never a live
 * `verification.secretName` lookup — so changing secretName after a
 * destination Allow cannot swap which credential is injected.
 */
export async function resolveWebhookHmacSigningSecret(input: {
	env: Env
	userId: OwnerId
	endpoint: WebhookEndpointRecord
}): Promise<string> {
	if (!input.endpoint.hmacSecretEncrypted) {
		throw new McpCallerError(
			`Webhook "${input.endpoint.webhookName}" declares HMAC verification but has no package-owned signing secret. Call webhookUrlMint (or webhookUrlRotate) so Kody can mint or migrate one onto the webhook URL record.`,
		)
	}
	return decryptWebhookHmacSecret(
		input.env,
		input.endpoint.hmacSecretEncrypted,
		userWebhookHmacSecretContext(input.userId, input.endpoint.id),
	)
}

export type WebhookHmacVerificationSecret = {
	value: string
	source: 'declared' | 'stored' | 'previous'
}

export type WebhookHmacVerificationSecretsResult = {
	secrets: Array<WebhookHmacVerificationSecret>
	/** Ciphertext of the live previous_* offered for CAS retirement. */
	previousHmacSecretEncrypted: string | null
}

/**
 * Secrets an inbound signature may match, in order. A declared
 * `verification.secretName` comes first: the endpoint may still hold a
 * Kody-generated secret from before the manifest declared one (enablement
 * migration or an earlier mint), and that must not shadow it. During the
 * 24h signing-secret grace window the previous snapshot is accepted next.
 * The stored secret stays as a fallback so deliveries that verify today keep
 * verifying. Throws when neither exists.
 *
 * Reconciles last-seen secretName / declared value on the endpoint when the
 * declared secret resolves, so a rename or value rotation records previous_*
 * with a rotation timestamp.
 */
export async function resolveWebhookHmacVerificationSecrets(input: {
	env: Env
	userId: OwnerId
	endpoint: WebhookEndpointRecord
	verification: PackageWebhookHmacVerificationEntry
	now?: Date | string
}): Promise<WebhookHmacVerificationSecretsResult> {
	const secrets: Array<WebhookHmacVerificationSecret> = []
	const secretName = input.verification.secretName?.trim() ?? ''
	let endpoint = input.endpoint
	const now = input.now ?? new Date()

	if (secretName) {
		const declared = await resolveDeclaredWebhookSecret({
			env: input.env,
			userId: input.userId,
			packageId: endpoint.packageId,
			secretName,
		})
		if (declared !== null) {
			endpoint = await reconcileWebhookHmacVerificationRotation({
				env: input.env,
				endpoint,
				secretName,
				declaredPlaintext: declared,
				now,
			})
			secrets.push({ value: declared, source: 'declared' })
		}
	} else if (
		endpoint.hmacSecretName ||
		endpoint.hmacVerificationSecretEncrypted ||
		endpoint.previousHmacSecretEncrypted
	) {
		// Package-owned HMAC (no secretName): drop last-seen declared tracking
		// so a later rotate of the leftover name cannot rearm previous_*, and
		// stop offering any prior named-secret grace under this auth model.
		const cleared = await setWebhookEndpointHmacVerificationState({
			db: input.env.APP_DB,
			userId: endpoint.userId,
			endpointId: endpoint.id,
			hmacSecretName: null,
			hmacVerificationSecretEncrypted: null,
			previousHmacSecretName: null,
			previousHmacSecretEncrypted: null,
			previousHmacSecretExpiresAt: null,
		})
		endpoint = cleared ?? {
			...endpoint,
			hmacSecretName: null,
			hmacVerificationSecretEncrypted: null,
			previousHmacSecretName: null,
			previousHmacSecretEncrypted: null,
			previousHmacSecretExpiresAt: null,
		}
	}

	let previousHmacSecretEncrypted: string | null = null
	if (isWebhookPreviousHmacLive(endpoint, now)) {
		try {
			const previous = await decryptWebhookVerificationSnapshot({
				env: input.env,
				userId: input.userId,
				endpointId: endpoint.id,
				encrypted: endpoint.previousHmacSecretEncrypted!,
			})
			if (!secrets.some((secret) => secret.value === previous)) {
				secrets.push({ value: previous, source: 'previous' })
				previousHmacSecretEncrypted = endpoint.previousHmacSecretEncrypted
			}
		} catch (error) {
			console.warn('webhook-previous-secret-decrypt-failed', {
				endpointId: endpoint.id,
				error,
			})
		}
	}

	if (endpoint.hmacSecretEncrypted) {
		let stored: string | null = null
		try {
			stored = await decryptWebhookHmacSecret(
				input.env,
				endpoint.hmacSecretEncrypted,
				userWebhookHmacSecretContext(input.userId, endpoint.id),
			)
		} catch (error) {
			if (secrets.length === 0) throw error
			console.warn('webhook-stored-secret-decrypt-failed', {
				endpointId: endpoint.id,
				error,
			})
		}
		if (stored !== null && !secrets.some((secret) => secret.value === stored)) {
			secrets.push({ value: stored, source: 'stored' })
		}
	}
	if (secrets.length === 0) {
		throw new McpCallerError(
			secretName
				? `Secret "${secretName}" was not found for this user.`
				: `Webhook "${endpoint.webhookName}" declares HMAC verification but has no package-owned signing secret.`,
		)
	}
	return { secrets, previousHmacSecretEncrypted }
}

async function resolveDeclaredWebhookSecret(input: {
	env: Env
	userId: OwnerId
	packageId: string
	secretName: string
}): Promise<string | null> {
	try {
		const resolved = await resolveCredential({
			env: input.env,
			orgId: input.userId,
			actor: null,
			packageStamp: attestedPackageStamp(input.packageId),
			baseUrl: getAppBaseUrl({ env: input.env }),
			credential: { use: 'webhook-secret', name: input.secretName },
		})
		return resolved.found && resolved.value ? resolved.value : null
	} catch (error) {
		console.warn('webhook-declared-secret-resolve-failed', {
			packageId: input.packageId,
			secretName: input.secretName,
			error,
		})
		return null
	}
}

/** Mint ciphertext for a new package-owned HMAC (verification without secretName). */
export async function mintPackageOwnedWebhookHmacCiphertext(input: {
	env: Env
	userId: OwnerId
	endpointId: string
}): Promise<{ plaintext: string; encrypted: string }> {
	const plaintext = await generateWebhookUrlSecret()
	const encrypted = await encryptWebhookHmacSecret(
		input.env,
		plaintext,
		userWebhookHmacSecretContext(input.userId, input.endpointId),
	)
	return { plaintext, encrypted }
}

/**
 * Ciphertext to write on mint/rotate when the endpoint has no package-owned
 * HMAC yet. Fresh mint when secretName is omitted; legacy copy from the named
 * secret when present (so apply no longer needs a live secrets-list lookup).
 * Returns undefined to leave the column unset / unchanged.
 *
 * An existing ciphertext is never replaced: destination grants approved
 * `{{webhookSecret}}` for that value, and a rotated URL's grace window still
 * receives deliveries signed with it.
 */
export async function resolveHmacCiphertextForMint(input: {
	env: Env
	request: RequestContext
	baseUrl: string
	userId: OwnerId
	endpointId: string
	packageId: string
	verification: PackageWebhookHmacVerificationEntry | null | undefined
	existingHmacEncrypted: string | null | undefined
}): Promise<string | undefined> {
	if (input.existingHmacEncrypted) return undefined
	if (!input.verification) return undefined

	const secretName = input.verification.secretName?.trim() ?? ''
	if (!secretName) {
		return (
			await mintPackageOwnedWebhookHmacCiphertext({
				env: input.env,
				userId: input.userId,
				endpointId: input.endpointId,
			})
		).encrypted
	}

	const resolved = await resolveCredential({
		env: input.env,
		orgId: input.userId,
		actor: input.request,
		packageStamp: attestedPackageStamp(input.packageId),
		baseUrl: input.baseUrl,
		credential: { use: 'webhook-secret', name: secretName },
	})
	if (!resolved.found || !resolved.value) return undefined

	return encryptWebhookHmacSecret(
		input.env,
		resolved.value,
		userWebhookHmacSecretContext(input.userId, input.endpointId),
	)
}
