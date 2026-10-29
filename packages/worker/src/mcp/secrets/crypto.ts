import {
	base64UrlToBytes,
	bytesToBase64Url,
} from '@kody-internal/shared/base64.ts'
import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'

const ivBytes = 12

/**
 * Ciphertext format version. Payloads are `v2.<iv>.<ciphertext>` bound to an
 * AES-GCM additional-authenticated-data (AAD) string built from the purpose
 * plus an identity context (e.g. the owning user), so a ciphertext copied
 * into another row fails to decrypt.
 */
const ciphertextVersion = 'v2'

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

const derivedEncryptionKeyCache = new Map<string, Promise<CryptoKey>>()

function buildAad(purpose: string, context: string) {
	return textEncoder.encode(`kody.${ciphertextVersion}|${purpose}|${context}`)
}

function deriveEncryptionKey(secret: string, purpose: string) {
	const cacheKey = `${purpose}:${secret}`
	const cached = derivedEncryptionKeyCache.get(cacheKey)
	if (cached) return cached

	const derivationPromise = crypto.subtle
		.digest('SHA-256', textEncoder.encode(`${purpose}:${secret}`))
		.then((digest) =>
			crypto.subtle.importKey('raw', digest, 'AES-GCM', false, [
				'encrypt',
				'decrypt',
			]),
		)
		.catch((error) => {
			derivedEncryptionKeyCache.delete(cacheKey)
			throw error
		})
	derivedEncryptionKeyCache.set(cacheKey, derivationPromise)
	return derivationPromise
}

async function encryptWithKey(
	keySecret: string,
	purpose: string,
	context: string,
	value: string,
) {
	const key = await deriveEncryptionKey(keySecret, purpose)
	const iv = crypto.getRandomValues(new Uint8Array(ivBytes))
	const ciphertext = await crypto.subtle.encrypt(
		{
			name: 'AES-GCM',
			iv,
			additionalData: buildAad(purpose, context),
		},
		key,
		textEncoder.encode(value),
	)
	return `${ciphertextVersion}.${bytesToBase64Url(iv)}.${bytesToBase64Url(
		new Uint8Array(ciphertext),
	)}`
}

async function decryptWithKey(
	keySecret: string,
	purpose: string,
	context: string,
	payload: string,
) {
	const parts = payload.split('.')
	const key = await deriveEncryptionKey(keySecret, purpose)
	if (parts.length !== 3) {
		throw new Error('Invalid encrypted secret payload.')
	}
	const [version, ivPart, ciphertextPart] = parts
	if (version !== ciphertextVersion || !ivPart || !ciphertextPart) {
		throw new Error('Invalid encrypted secret payload.')
	}
	const plaintext = await crypto.subtle.decrypt(
		{
			name: 'AES-GCM',
			iv: base64UrlToBytes(ivPart),
			additionalData: buildAad(purpose, context),
		},
		key,
		base64UrlToBytes(ciphertextPart),
	)
	return textDecoder.decode(plaintext)
}

const secretStorePurpose = 'mcp-secret-store'

/**
 * Platform OAuth client secrets share the SECRET_STORE_KEY KEK but use a
 * dedicated purpose so their ciphertext is never interchangeable with
 * `secret_entries` payloads. They live outside the user secret store on
 * purpose: nothing in the `{{secret:...}}` placeholder namespace can name
 * them, so sandboxed code has no resolution path to the shared credential.
 */
const platformOauthClientSecretPurpose = 'platform-oauth-client-secret'
const userOauthAccessTokenPurpose = 'user-oauth-access-token'
const userOauthRefreshTokenPurpose = 'user-oauth-refresh-token'
const userOauthClientSecretPurpose = 'user-oauth-client-secret'
const webhookUrlSecretPurpose = 'webhook-url-secret'
/** Package-owned HMAC signing material on webhook_endpoints (not user secrets). */
const webhookHmacSecretPurpose = 'webhook-hmac-secret'
/** Client-supplied `whsec_` signing secrets on mcp_event_subscriptions. */
const mcpEventSubscriptionSecretPurpose = 'mcp-event-subscription-secret'
/** Pre-registered OAuth client secrets for user-added MCP servers. */
const mcpServerOAuthClientSecretPurpose = 'mcp-server-oauth-client-secret'
/** Session tokens a `login` credential's exchange returned (never code-readable). */
const loginCredentialSessionPurpose = 'login-credential-session'

/** AAD context for a user-owned secret ciphertext. */
export function userSecretContext(userId: OwnerId) {
	return `user:${userId}`
}

/** AAD context for a platform OAuth app client secret ciphertext. */
export function platformOauthAppContext(slug: string) {
	return `app:${slug}`
}

/** AAD context for a user-lane OAuth connection token ciphertext. */
export function userIntegrationCredentialContext(
	userId: OwnerId,
	integrationName: string,
) {
	return `user:${userId}:integration:${integrationName}`
}

/** AAD context for a user-lane OAuth app client secret ciphertext. */
export function userOauthAppCredentialContext(userId: OwnerId, slug: string) {
	return `user:${userId}:oauth-app:${slug}`
}

export async function encryptPlatformOauthClientSecret(
	env: Pick<Env, 'SECRET_STORE_KEY'>,
	value: string,
	context: string,
) {
	return encryptWithKey(
		env.SECRET_STORE_KEY,
		platformOauthClientSecretPurpose,
		context,
		value,
	)
}

export async function decryptPlatformOauthClientSecret(
	env: Pick<Env, 'SECRET_STORE_KEY'>,
	payload: string,
	context: string,
) {
	try {
		return await decryptWithKey(
			env.SECRET_STORE_KEY,
			platformOauthClientSecretPurpose,
			context,
			payload,
		)
	} catch {
		throw new Error('Unable to decrypt platform client secret.')
	}
}

export async function encryptUserOauthAccessToken(
	env: Pick<Env, 'SECRET_STORE_KEY'>,
	value: string,
	context: string,
) {
	return encryptWithKey(
		env.SECRET_STORE_KEY,
		userOauthAccessTokenPurpose,
		context,
		value,
	)
}

export async function decryptUserOauthAccessToken(
	env: Pick<Env, 'SECRET_STORE_KEY'>,
	payload: string,
	context: string,
) {
	try {
		return await decryptWithKey(
			env.SECRET_STORE_KEY,
			userOauthAccessTokenPurpose,
			context,
			payload,
		)
	} catch {
		throw new Error('Unable to decrypt integration access token.')
	}
}

export async function encryptUserOauthRefreshToken(
	env: Pick<Env, 'SECRET_STORE_KEY'>,
	value: string,
	context: string,
) {
	return encryptWithKey(
		env.SECRET_STORE_KEY,
		userOauthRefreshTokenPurpose,
		context,
		value,
	)
}

export async function decryptUserOauthRefreshToken(
	env: Pick<Env, 'SECRET_STORE_KEY'>,
	payload: string,
	context: string,
) {
	try {
		return await decryptWithKey(
			env.SECRET_STORE_KEY,
			userOauthRefreshTokenPurpose,
			context,
			payload,
		)
	} catch {
		throw new Error('Unable to decrypt integration refresh token.')
	}
}

export async function encryptUserOauthClientSecret(
	env: Pick<Env, 'SECRET_STORE_KEY'>,
	value: string,
	context: string,
) {
	return encryptWithKey(
		env.SECRET_STORE_KEY,
		userOauthClientSecretPurpose,
		context,
		value,
	)
}

export async function decryptUserOauthClientSecret(
	env: Pick<Env, 'SECRET_STORE_KEY'>,
	payload: string,
	context: string,
) {
	try {
		return await decryptWithKey(
			env.SECRET_STORE_KEY,
			userOauthClientSecretPurpose,
			context,
			payload,
		)
	} catch {
		throw new Error('Unable to decrypt OAuth app client secret.')
	}
}

/** AAD context for a minted webhook URL secret ciphertext. */
export function userWebhookUrlSecretContext(
	userId: OwnerId,
	endpointId: string,
) {
	return `user:${userId}:webhook-endpoint:${endpointId}`
}

export async function encryptWebhookUrlSecret(
	env: Pick<Env, 'SECRET_STORE_KEY'>,
	value: string,
	context: string,
) {
	return encryptWithKey(
		env.SECRET_STORE_KEY,
		webhookUrlSecretPurpose,
		context,
		value,
	)
}

export async function decryptWebhookUrlSecret(
	env: Pick<Env, 'SECRET_STORE_KEY'>,
	payload: string,
	context: string,
) {
	try {
		return await decryptWithKey(
			env.SECRET_STORE_KEY,
			webhookUrlSecretPurpose,
			context,
			payload,
		)
	} catch {
		throw new Error('Unable to decrypt webhook URL secret.')
	}
}

/**
 * AAD context for package-owned webhook HMAC ciphertext. Same endpoint
 * identity as the URL secret so rotate/remint keep one binding per row.
 */
export function userWebhookHmacSecretContext(
	userId: OwnerId,
	endpointId: string,
) {
	return `user:${userId}:webhook-endpoint:${endpointId}:hmac`
}

export async function encryptWebhookHmacSecret(
	env: Pick<Env, 'SECRET_STORE_KEY'>,
	value: string,
	context: string,
) {
	return encryptWithKey(
		env.SECRET_STORE_KEY,
		webhookHmacSecretPurpose,
		context,
		value,
	)
}

export async function decryptWebhookHmacSecret(
	env: Pick<Env, 'SECRET_STORE_KEY'>,
	payload: string,
	context: string,
) {
	try {
		return await decryptWithKey(
			env.SECRET_STORE_KEY,
			webhookHmacSecretPurpose,
			context,
			payload,
		)
	} catch {
		throw new Error('Unable to decrypt webhook HMAC secret.')
	}
}

/** AAD context for an MCP event subscription signing secret ciphertext. */
export function userMcpEventSubscriptionSecretContext(
	userId: OwnerId,
	subscriptionId: string,
) {
	return `user:${userId}:mcp-event-subscription:${subscriptionId}`
}

export async function encryptMcpEventSubscriptionSecret(
	env: Pick<Env, 'SECRET_STORE_KEY'>,
	value: string,
	context: string,
) {
	return encryptWithKey(
		env.SECRET_STORE_KEY,
		mcpEventSubscriptionSecretPurpose,
		context,
		value,
	)
}

export async function decryptMcpEventSubscriptionSecret(
	env: Pick<Env, 'SECRET_STORE_KEY'>,
	payload: string,
	context: string,
) {
	try {
		return await decryptWithKey(
			env.SECRET_STORE_KEY,
			mcpEventSubscriptionSecretPurpose,
			context,
			payload,
		)
	} catch {
		throw new Error('Unable to decrypt MCP event subscription secret.')
	}
}

/**
 * AAD context for an MCP server's pre-registered OAuth client secret. The
 * MCP client hub decrypts it and knows servers only by id, which is a
 * UUID that never moves between owners.
 */
export function mcpServerOAuthClientSecretContext(serverId: string) {
	return `mcp-server:${serverId}:oauth-client`
}

export async function encryptMcpServerOAuthClientSecret(
	env: Pick<Env, 'SECRET_STORE_KEY'>,
	value: string,
	context: string,
) {
	return encryptWithKey(
		env.SECRET_STORE_KEY,
		mcpServerOAuthClientSecretPurpose,
		context,
		value,
	)
}

export async function decryptMcpServerOAuthClientSecret(
	env: Pick<Env, 'SECRET_STORE_KEY'>,
	payload: string,
	context: string,
) {
	try {
		return await decryptWithKey(
			env.SECRET_STORE_KEY,
			mcpServerOAuthClientSecretPurpose,
			context,
			payload,
		)
	} catch {
		throw new Error('Unable to decrypt MCP server OAuth client secret.')
	}
}

export async function encryptSecretValue(
	env: Pick<Env, 'SECRET_STORE_KEY'>,
	value: string,
	context: string,
) {
	return encryptWithKey(
		env.SECRET_STORE_KEY,
		secretStorePurpose,
		context,
		value,
	)
}

export async function decryptSecretValue(
	env: Pick<Env, 'SECRET_STORE_KEY'>,
	payload: string,
	context: string,
) {
	try {
		return await decryptWithKey(
			env.SECRET_STORE_KEY,
			secretStorePurpose,
			context,
			payload,
		)
	} catch {
		throw new Error('Unable to decrypt secret value.')
	}
}

/** AAD context for a login session: its credential and revision. */
export function loginCredentialSessionContext(input: {
	ownerId: OwnerId
	credentialId: string
	revision: string
}) {
	return `user:${input.ownerId}:login-session:${input.credentialId}:${input.revision}`
}

export async function encryptLoginCredentialSession(
	env: Pick<Env, 'SECRET_STORE_KEY'>,
	value: string,
	context: string,
) {
	return encryptWithKey(
		env.SECRET_STORE_KEY,
		loginCredentialSessionPurpose,
		context,
		value,
	)
}

export async function decryptLoginCredentialSession(
	env: Pick<Env, 'SECRET_STORE_KEY'>,
	payload: string,
	context: string,
) {
	try {
		return await decryptWithKey(
			env.SECRET_STORE_KEY,
			loginCredentialSessionPurpose,
			context,
			payload,
		)
	} catch {
		throw new Error('Unable to decrypt login session.')
	}
}
