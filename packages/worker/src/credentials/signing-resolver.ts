/**
 * Signing through `resolveCredential` (`use: 'signing'`): the value is key
 * material that never leaves the host. A caller asks for a signature (a JWT
 * over its claims, or an HMAC over its message) for a request to one of the
 * credential's hosts and gets back only the signature.
 *
 * JWT requires a stored credential with kind `signing`. HMAC also accepts a
 * Key (`secret`) so webhook CRC / signature helpers can use the same Key the
 * webhook `secretName` path already resolves — without forcing owners to
 * re-kind the credential as `signing`.
 */
import {
	signJwtWithSecret,
	type SignJwtWithSecretInput,
} from '#mcp/capabilities/secrets/jwt-signing.ts'
import { computeWebhookHmacSignature } from '#worker/webhooks/crypto.ts'
import type {
	WebhookHmacAlgorithm,
	WebhookSignatureEncoding,
} from '#worker/webhooks/types.ts'
import {
	credentialHostsAllow,
	CredentialRequestRefusedError,
} from './credential-request.ts'
import type { CredentialResolver } from './credential-resolver.ts'
import {
	authorizeStoredCredential,
	findStoredCredential,
} from './stored-credential.ts'

export type SigningOperation =
	| ({ type: 'jwt' } & SignJwtWithSecretInput)
	| {
			type: 'hmac'
			algorithm: WebhookHmacAlgorithm
			message: string | ArrayBuffer
			encoding: WebhookSignatureEncoding
			/** Prepended to the encoded digest, e.g. `sha256=`. */
			prefix?: string
	  }

export type SigningResult = { signature: string }

async function sign(value: string, operation: SigningOperation) {
	switch (operation.type) {
		case 'jwt':
			return await signJwtWithSecret(value, operation)
		case 'hmac':
			return await computeWebhookHmacSignature({
				algorithm: operation.algorithm,
				secret: value,
				body:
					typeof operation.message === 'string'
						? (new TextEncoder().encode(operation.message)
								.buffer as ArrayBuffer)
						: operation.message,
				encoding: operation.encoding,
				prefix: operation.prefix,
			})
		default: {
			const exhaustive: never = operation
			throw new Error(`Unhandled signing operation: ${String(exhaustive)}`)
		}
	}
}

export const signingCredentialResolver: CredentialResolver<'signing'> = {
	auditSubject: (credential) => ({
		use: credential.use,
		resourceType: 'secret',
		name: credential.credentialId,
		credentialId: null,
		details: {
			host: credential.requestHost,
			operation: credential.operation.type,
			algorithm: credential.operation.algorithm,
		},
	}),
	async resolve(call) {
		const { credential } = call
		const lookup = await findStoredCredential(call, credential.credentialId)
		return {
			async authorize() {
				const expectedKind =
					credential.operation.type === 'hmac' &&
					lookup?.found.kind === 'secret'
						? 'secret'
						: 'signing'
				const found = await authorizeStoredCredential(
					call,
					credential.credentialId,
					lookup,
					expectedKind,
				)
				if (!credentialHostsAllow(found.allowedHosts, credential.requestHost)) {
					throw new CredentialRequestRefusedError(
						'host_not_allowed',
						'This credential does not sign requests to that host.',
					)
				}
			},
			async apply(): Promise<SigningResult> {
				// `authorize` returned, so the lookup found a usable credential.
				const value = await lookup!.readValue()
				return { signature: await sign(value, credential.operation) }
			},
		}
	},
	isFound: () => true,
}
