/**
 * Where the fetch gateway may fill a credential. A placeholder may sit in a
 * request header, the URL path or query, or a text body. Checked before any
 * credential resolves:
 *
 * - the request is HTTPS;
 * - no placeholder sits in the URL host or user info, so filling one can never
 *   change where the request goes.
 *
 * Each credential's allowed hosts are checked by the credential door with the
 * request host.
 */
import { McpCallerError } from '#mcp/caller-error.ts'
import {
	type CredentialPlacementRefusedPart,
	credentialPlacementRefusedCode,
	formatCredentialPlacementRefusalTag,
} from '#worker/credentials/placement-refusal.ts'
import {
	buildBasicAuthSecretPlaceholderFromReference,
	buildIntegrationTokenPlaceholder,
	buildProviderSecretPlaceholder,
	buildSecretPlaceholder,
	decodeSecretPlaceholderPunctuation,
	parseBasicAuthSecretPlaceholders,
	parseIntegrationTokenPlaceholders,
	parseProviderSecretPlaceholders,
	parseSecretPlaceholders,
} from './placeholders.ts'

/**
 * The message ends with a `(credential_placement_refused, slot "…", part "…")`
 * tag so the cause survives the sandbox boundary, where only the message
 * crosses. `part` is set when a fill placement refused that request part.
 */
export class SecretPlacementError extends McpCallerError {
	readonly code = credentialPlacementRefusedCode
	readonly slot: string | null
	readonly part: CredentialPlacementRefusedPart | null
	constructor(
		message: string,
		slot: string | null,
		part: CredentialPlacementRefusedPart | null = null,
	) {
		super(`${message} ${formatCredentialPlacementRefusalTag(slot, part)}`)
		this.name = 'SecretPlacementError'
		this.slot = slot
		this.part = part
	}
}

type PlacedReference =
	| { kind: 'secret'; name: string; placeholder: string }
	| {
			kind: 'secret-basic'
			usernameName: string
			passwordName: string
			placeholder: string
	  }
	| { kind: 'integration-token'; name: string; placeholder: string }
	| { kind: 'provider-secret'; provider: string; placeholder: string }

function referencesIn(value: string): PlacedReference[] {
	return [
		...parseSecretPlaceholders(value).map((secret) => ({
			kind: 'secret' as const,
			name: secret.name,
			placeholder: buildSecretPlaceholder(secret),
		})),
		...parseBasicAuthSecretPlaceholders(value).map((basic) => ({
			kind: 'secret-basic' as const,
			usernameName: basic.username.name,
			passwordName: basic.password.name,
			placeholder: buildBasicAuthSecretPlaceholderFromReference(basic),
		})),
		...parseIntegrationTokenPlaceholders(value).map((name) => ({
			kind: 'integration-token' as const,
			name,
			placeholder: buildIntegrationTokenPlaceholder(name),
		})),
		...parseProviderSecretPlaceholders(value).map((provider) => ({
			kind: 'provider-secret' as const,
			provider: provider.provider,
			placeholder: buildProviderSecretPlaceholder(provider),
		})),
	]
}

/**
 * The one slot a refusal is about. A Basic Auth pair names two slots, so a
 * refusal of the whole pair names neither.
 */
function slotOf(reference: PlacedReference) {
	switch (reference.kind) {
		case 'secret':
		case 'integration-token':
			return reference.name
		case 'secret-basic':
		case 'provider-secret':
			return null
		default: {
			const exhaustive: never = reference
			throw new Error(`Unhandled placeholder: ${String(exhaustive)}`)
		}
	}
}

function describeReference(reference: PlacedReference) {
	switch (reference.kind) {
		case 'secret':
			return `Secret "${reference.name}"`
		case 'secret-basic':
			return `Basic auth secret pair "${reference.usernameName}" / "${reference.passwordName}"`
		case 'integration-token':
			return `Integration token "${reference.name}"`
		case 'provider-secret':
			return `Vault secret from "${reference.provider}"`
		default: {
			const exhaustive: never = reference
			throw new Error(`Unhandled placeholder: ${String(exhaustive)}`)
		}
	}
}

/**
 * Throws a {@link SecretPlacementError} naming the credential and the host
 * when `values` (every header value, URL part, and body text the gateway would
 * fill) hold a placeholder and the request is not HTTPS, or when the URL host
 * or user info holds one.
 */
export function assertSecretPlacement(input: {
	url: URL
	values: ReadonlyArray<string>
}) {
	const { url } = input
	const authority = decodeSecretPlaceholderPunctuation(
		`${url.username}:${url.password}@${url.host}`,
	)
	const authorityReference = referencesIn(authority)[0]
	if (authorityReference) {
		throw new SecretPlacementError(
			`${describeReference(authorityReference)} is in the host or user info of the request URL. The fetch gateway fills a secret in the URL path or query, a header, or the body, never where it could change the host. Put it in a header, for example headers: { Authorization: 'Bearer ${authorityReference.placeholder}' }.`,
			slotOf(authorityReference),
		)
	}
	const reference = input.values.flatMap(referencesIn)[0]
	if (!reference) return
	if (url.protocol !== 'https:') {
		throw new SecretPlacementError(
			`${describeReference(reference)} cannot be sent to host "${url.hostname}" over plain HTTP. The fetch gateway fills secrets only over HTTPS. Use an https:// URL.`,
			slotOf(reference),
		)
	}
}
