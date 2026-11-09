/**
 * Signing through `resolveCredential` (`use: 'signing'`): the value is key
 * material that never leaves the host. A caller asks for a signature (a JWT
 * over its claims, an HMAC over its message, or an RSA HTTP signature over a
 * request Kody canonicalizes) for a request to one of the credential's hosts
 * and gets back only the signature or the headers to send.
 *
 * Raw RSA-SHA256 over any string (`rsa-sha256`) is refused unless the owner
 * turned it on for the credential on the website (ADR 0099). Every raw
 * signature, and every refusal of one, is listed on the credential's page.
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
	CredentialNotFoundError,
	credentialHostsAllow,
	CredentialRequestRefusedError,
} from './credential-request.ts'
import {
	type HttpSignatureOperation,
	prepareHttpSignature,
	type PreparedHttpSignature,
	readRawRsaMessage,
	type RawRsaSignOperation,
	signHttpRequest,
	signRawRsaSha256,
} from './http-signature.ts'
import {
	readRawSigningSetting,
	recordRawSigningEvent,
	type RawSigningRefusalReason,
} from './raw-signing-store.ts'
import type { CredentialResolver, ResolverCall } from './credential-resolver.ts'
import {
	authorizeStoredCredential,
	findStoredCredential,
} from './stored-credential.ts'
import { AuthorizationError } from '#worker/authorization/authorize.ts'

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
	| HttpSignatureOperation
	| RawRsaSignOperation

export const signingOperationTypes: ReadonlyArray<SigningOperation['type']> = [
	'jwt',
	'hmac',
	'http-signature',
	'rsa-sha256',
]

/**
 * `signature` is the signature itself, or for `http-signature` the value of
 * the header that carries it; `headers` are the headers to add.
 */
export type SigningResult = {
	signature: string
	headers?: Record<string, string>
}

function auditAlgorithm(operation: SigningOperation) {
	switch (operation.type) {
		case 'http-signature':
		case 'rsa-sha256':
			return 'rsa-sha256'
		default:
			return operation.algorithm
	}
}

function rawRefusalReason(error: unknown): RawSigningRefusalReason | null {
	if (error instanceof CredentialRequestRefusedError) {
		return error.code === 'raw_signing_off'
			? 'raw_signing_off'
			: 'invalid_request'
	}
	if (
		error instanceof AuthorizationError ||
		error instanceof CredentialNotFoundError
	) {
		return 'no_access'
	}
	return null
}

/** Who asked, for the credential's Raw signatures list. Never a value. */
function rawSigningEventBase(
	call: ResolverCall,
	credentialId: string,
	orgId: string,
) {
	const actor = call.input.actor
	return {
		orgId,
		credentialId,
		actorUserId: actor?.actor?.userId ?? null,
		actorUsername: actor?.actor?.username ?? null,
		tokenId: actor?.credential.id ?? null,
		via: actor?.credential.kind ?? null,
		profileId: actor?.credential.profileId ?? null,
		packageId:
			call.input.packageStamp?.packageId ?? call.input.runPackageId ?? null,
	}
}

async function sign(
	value: string,
	operation: SigningOperation,
	prepared: PreparedHttpSignature | null,
): Promise<SigningResult> {
	switch (operation.type) {
		case 'http-signature': {
			const headers = await signHttpRequest(value, operation, prepared!)
			return {
				signature: headers.authorization ?? headers.signature!,
				headers,
			}
		}
		case 'rsa-sha256':
			return { signature: await signRawRsaSha256(value, operation) }
		case 'jwt':
			return { signature: await signJwtWithSecret(value, operation) }
		case 'hmac':
			return {
				signature: await computeWebhookHmacSignature({
					algorithm: operation.algorithm,
					secret: value,
					body:
						typeof operation.message === 'string'
							? (new TextEncoder().encode(operation.message)
									.buffer as ArrayBuffer)
							: operation.message,
					encoding: operation.encoding,
					prefix: operation.prefix,
				}),
			}
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
			algorithm: auditAlgorithm(credential.operation),
			...(credential.operation.type === 'http-signature'
				? {
						scheme: credential.operation.scheme ?? 'draft-cavage',
						profile: credential.operation.profile ?? 'oracle',
					}
				: {}),
		},
	}),
	async resolve(call) {
		const { credential } = call
		const { operation } = credential
		const lookup = await findStoredCredential(call, credential.credentialId)
		let prepared: PreparedHttpSignature | null = null
		const rawEvent =
			operation.type === 'rsa-sha256' && lookup
				? rawSigningEventBase(
						call,
						lookup.found.credentialId,
						lookup.found.ownerId,
					)
				: null
		const authorizeSigning = async () => {
			const expectedKind =
				operation.type === 'hmac' && lookup?.found.kind === 'secret'
					? 'secret'
					: 'signing'
			const found = await authorizeStoredCredential(
				call,
				credential.credentialId,
				lookup,
				expectedKind,
			)
			if (operation.type === 'http-signature') {
				prepared = await prepareHttpSignature(operation)
				// The host the client named must be the host the signature covers.
				if (prepared.host !== credential.requestHost.trim().toLowerCase()) {
					throw new CredentialRequestRefusedError(
						'host_not_allowed',
						'The url host does not match the host this signature is for.',
					)
				}
			}
			if (!credentialHostsAllow(found.allowedHosts, credential.requestHost)) {
				throw new CredentialRequestRefusedError(
					'host_not_allowed',
					'This credential does not sign requests to that host.',
				)
			}
			if (operation.type === 'rsa-sha256') {
				readRawRsaMessage(operation)
				const setting = await readRawSigningSetting(
					call.input.env.APP_DB,
					found.credentialId,
				)
				if (!setting?.enabled) {
					throw new CredentialRequestRefusedError(
						'raw_signing_off',
						'Raw signing is off for this credential. Only its owner can turn it on, on the credential\'s page on the Kody website. Prefer { type: "http-signature" }, which signs only requests to the credential\'s hosts.',
					)
				}
			}
		}
		return {
			async authorize() {
				try {
					await authorizeSigning()
				} catch (error) {
					const reason = rawEvent ? rawRefusalReason(error) : null
					if (rawEvent && reason) {
						await recordRawSigningEvent(call.input.env.APP_DB, {
							...rawEvent,
							messageBytes: null,
							outcome: 'refused',
							refusalReason: reason,
						})
					}
					throw error
				}
			},
			async apply(): Promise<SigningResult> {
				// `authorize` returned, so the lookup found a usable credential.
				const value = await lookup!.readValue()
				const result = await sign(value, operation, prepared)
				if (rawEvent && operation.type === 'rsa-sha256') {
					// Fail closed: no history row, no signature.
					await recordRawSigningEvent(call.input.env.APP_DB, {
						...rawEvent,
						messageBytes: readRawRsaMessage(operation).bytes.byteLength,
						outcome: 'signed',
						refusalReason: null,
					})
				}
				return result
			},
		}
	},
	isFound: () => true,
}
