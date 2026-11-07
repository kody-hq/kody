/**
 * Stable marker for a fetch the gateway refused because a credential
 * placeholder was headed to a host its credential does not allow, over plain
 * HTTP, into the URL host, or into a request part outside the credential's
 * fill placement. Only the error message crosses the sandbox boundary, so the
 * gateway appends this tag to the message and surfaces downstream (webhook
 * responses) read it back. The tag carries the slot name and refused request
 * part only, never a value.
 */
export const credentialPlacementRefusedCode = 'credential_placement_refused'

/** The request part a fill placement refusal is about. */
export type CredentialPlacementRefusedPart =
	| 'header'
	| 'query'
	| 'path'
	| 'body'

export type CredentialPlacementRefusal = {
	slot: string | null
	part: CredentialPlacementRefusedPart | null
}

const slotNamePattern = /^[a-zA-Z0-9._-]+$/
const refusalTagPattern =
	/\(credential_placement_refused(?:, slot "([a-zA-Z0-9._-]+)")?(?:, part "(header|query|path|body)")?\)/

export function formatCredentialPlacementRefusalTag(
	slot: string | null,
	part: CredentialPlacementRefusedPart | null = null,
) {
	const slotPhrase =
		slot && slotNamePattern.test(slot) ? `, slot "${slot}"` : ''
	const partPhrase = part ? `, part "${part}"` : ''
	return `(${credentialPlacementRefusedCode}${slotPhrase}${partPhrase})`
}

export function readCredentialPlacementRefusal(
	message: string,
): CredentialPlacementRefusal | null {
	const match = refusalTagPattern.exec(message)
	if (!match) return null
	return {
		slot: match[1] ?? null,
		part: (match[2] as CredentialPlacementRefusedPart | undefined) ?? null,
	}
}

/** `message` without a trailing refusal tag, for messages parsed further. */
export function stripCredentialPlacementRefusalTag(message: string) {
	return message.replace(new RegExp(`\\s*${refusalTagPattern.source}\\s*$`), '')
}

/** Reads the refusal tag from a package invocation error response body. */
export function readCredentialPlacementRefusalFromInvocationBody(
	body: unknown,
): CredentialPlacementRefusal | null {
	if (!body || typeof body !== 'object') return null
	const error = (body as Record<string, unknown>)['error']
	if (!error || typeof error !== 'object') return null
	const message = (error as Record<string, unknown>)['message']
	return typeof message === 'string'
		? readCredentialPlacementRefusal(message)
		: null
}

function refusedPartPhrase(part: CredentialPlacementRefusedPart) {
	switch (part) {
		case 'header':
			return 'that request header'
		case 'query':
			return 'the URL query'
		case 'path':
			return 'the URL path'
		case 'body':
			return 'the request body'
		default: {
			const exhaustive: never = part
			throw new Error(`Unhandled part: ${String(exhaustive)}`)
		}
	}
}

/**
 * The error a webhook caller sees: the code, slot name, and refused request
 * part, nothing from the package, the request, or the credential.
 */
export function buildCredentialPlacementRefusedWebhookError(
	refusal: CredentialPlacementRefusal,
) {
	const { slot, part } = refusal
	const slotPhrase = slot ? ` (slot "${slot}")` : ''
	const message = part
		? `The package tried to send a credential${slotPhrase} in ${refusedPartPhrase(part)}, which the credential's fill placement does not allow, so Kody refused the request. The credential's owner can allow it in the credential's fill placement setting, or the package owner can send the credential where it is allowed.`
		: `The package tried to send a credential${slotPhrase} to a host the credential does not allow, over plain HTTP, or in the URL host, so Kody refused the request. The package owner or the credential's owner needs to fix it.`
	return {
		code: credentialPlacementRefusedCode,
		message,
		...(slot ? { slot } : {}),
		...(part ? { part } : {}),
	}
}
