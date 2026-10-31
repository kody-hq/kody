/**
 * Shared rules for the request-placing credential kinds (ADR 0068): which
 * hosts a credential's `hosts` allow, and the structured refusals their
 * resolvers throw. A refusal never carries a credential value.
 */
import { normalizeHost } from '#mcp/secrets/allowed-hosts.ts'

export type CredentialRequestRefusal =
	/** The request host is not in the credential's `hosts`. */
	| 'host_not_allowed'
	/** The request is not HTTPS. */
	| 'insecure_transport'
	/** The request does not have the shape the credential's kind takes. */
	| 'invalid_request'

export class CredentialRequestRefusedError extends Error {
	readonly code: CredentialRequestRefusal
	constructor(code: CredentialRequestRefusal, message: string) {
		super(message)
		this.name = 'CredentialRequestRefusedError'
		this.code = code
	}
}

/**
 * The picked credential does not exist, is another kind, or the actor cannot
 * use it. One error for all three, so it does not reveal which.
 */
export class CredentialNotFoundError extends Error {
	readonly code = 'credential_not_found'
	constructor() {
		super('No credential with that id that you can use for this request.')
		this.name = 'CredentialNotFoundError'
	}
}

/**
 * A login credential's exchange did not return a session. It carries only
 * the HTTP status (null when the request did not complete), never the login
 * response, which may echo the fields.
 */
export class CredentialLoginFailedError extends Error {
	readonly code = 'login_failed'
	readonly status: number | null
	/** The provider answered `invalid_grant`: the refresh token is revoked or invalid. */
	readonly invalidGrant: boolean
	/** The provider's `Retry-After`, in seconds, when it sent one. */
	readonly providerRetryAfterSeconds: number | null
	/** Seconds until Kody runs this exchange again, once the failure is recorded. */
	readonly retryAfterSeconds: number | null
	constructor(
		status: number | null,
		options: {
			invalidGrant?: boolean
			providerRetryAfterSeconds?: number | null
			retryAfterSeconds?: number | null
		} = {},
	) {
		const failed =
			status == null
				? 'The login exchange did not complete.'
				: `The login exchange did not return a session (HTTP ${status}).`
		super(
			options.retryAfterSeconds == null
				? failed
				: `${failed} Kody runs it again after ${options.retryAfterSeconds} seconds; retry then.`,
		)
		this.name = 'CredentialLoginFailedError'
		this.status = status
		this.invalidGrant = options.invalidGrant ?? false
		this.providerRetryAfterSeconds = options.providerRetryAfterSeconds ?? null
		this.retryAfterSeconds = options.retryAfterSeconds ?? null
	}
}

/**
 * A login credential's exchange failed recently and is cooling down, so Kody
 * did not run it. Retry after `retryAfterSeconds`.
 */
export class CredentialLoginRetryLaterError extends Error {
	readonly code = 'login_retry_later'
	readonly retryAfterSeconds: number
	constructor(retryAfterSeconds: number) {
		super(
			`This login's exchange failed recently, so Kody is not running it again yet. Retry after ${retryAfterSeconds} seconds.`,
		)
		this.name = 'CredentialLoginRetryLaterError'
		this.retryAfterSeconds = retryAfterSeconds
	}
}

/**
 * The provider rejected a login credential's refresh token (`invalid_grant`).
 * Kody stops running its exchange until the owner saves a new value.
 */
export class CredentialLoginNeedsReconnectError extends Error {
	readonly code = 'login_needs_reconnect'
	constructor() {
		super(
			"The provider rejected this login's saved refresh token (invalid_grant), so Kody stopped running its exchange. The credential's owner reconnects it by saving a new value; until then, requests with it fail.",
		)
		this.name = 'CredentialLoginNeedsReconnectError'
	}
}

/**
 * Whether `hosts` allow `host`: an exact host, or a `*.example.com` entry,
 * which matches exactly one more label (`api.example.com`, not
 * `example.com` or `a.b.example.com`). No hosts allow nothing.
 */
export function credentialHostsAllow(
	hosts: ReadonlyArray<string>,
	host: string,
) {
	const target = normalizeHost(host)
	if (!target) return false
	return hosts.some((entry) => {
		const normalized = entry.trim().toLowerCase()
		if (!normalized.startsWith('*.'))
			return normalizeHost(normalized) === target
		const suffix = normalized.slice(1)
		if (!target.endsWith(suffix)) return false
		const label = target.slice(0, -suffix.length)
		return label.length > 0 && !label.includes('.')
	})
}

export function assertHttpsUrl(url: URL) {
	if (url.protocol !== 'https:') {
		throw new CredentialRequestRefusedError(
			'insecure_transport',
			'Credentials are only sent over HTTPS.',
		)
	}
}
