import {
	bytesToBase64,
	bytesToBase64Url,
} from '@kody-internal/shared/base64.ts'
import { toHex } from '@kody-internal/shared/hex.ts'
import { sha256Hex } from '@kody-internal/shared/sha256.ts'
import { timingSafeEqualString } from '@kody-internal/shared/timing-safe.ts'
import type {
	WebhookHmacAlgorithm,
	WebhookSignatureEncoding,
	WebhookTimestampFormat,
} from './types.ts'

const urlSecretBytes = 32
const unixIntegerPattern = /^\d+$/

export async function hashWebhookUrlSecret(secret: string) {
	return sha256Hex(secret)
}

export async function generateWebhookUrlSecret() {
	const bytes = crypto.getRandomValues(new Uint8Array(urlSecretBytes))
	return bytesToBase64Url(bytes)
}

export async function webhookUrlSecretMatches(input: {
	candidate: string
	storedHash: string
}) {
	const candidateHash = await hashWebhookUrlSecret(input.candidate)
	return timingSafeEqualString(candidateHash, input.storedHash)
}

/**
 * Compare the path secret against current and previous hashes. Both hashes
 * are compared when a previous hash is present so timing does not reveal
 * which generation matched.
 */
export async function matchWebhookIngressUrlSecret(input: {
	candidate: string
	currentHash: string
	previousHash: string | null
}): Promise<'current' | 'previous' | null> {
	const currentMatches = await webhookUrlSecretMatches({
		candidate: input.candidate,
		storedHash: input.currentHash,
	})
	const previousMatches = input.previousHash
		? await webhookUrlSecretMatches({
				candidate: input.candidate,
				storedHash: input.previousHash,
			})
		: false
	if (currentMatches) return 'current'
	if (previousMatches) return 'previous'
	return null
}

function hmacHashName(algorithm: WebhookHmacAlgorithm) {
	switch (algorithm) {
		case 'hmac-sha256':
			return 'SHA-256'
		case 'hmac-sha1':
			return 'SHA-1'
		default: {
			const exhaustive: never = algorithm
			throw new Error(`Unhandled HMAC algorithm: ${String(exhaustive)}`)
		}
	}
}

function encodeSignature(
	digest: ArrayBuffer,
	encoding: WebhookSignatureEncoding,
) {
	const bytes = new Uint8Array(digest)
	switch (encoding) {
		case 'hex':
			return toHex(bytes)
		case 'base64':
			return bytesToBase64(bytes)
		default: {
			const exhaustive: never = encoding
			throw new Error(`Unhandled signature encoding: ${String(exhaustive)}`)
		}
	}
}

export async function computeWebhookHmacSignature(input: {
	algorithm: WebhookHmacAlgorithm
	secret: string
	body: ArrayBuffer
	encoding: WebhookSignatureEncoding
	prefix?: string
}) {
	const key = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(input.secret),
		{ name: 'HMAC', hash: hmacHashName(input.algorithm) },
		false,
		['sign'],
	)
	const digest = await crypto.subtle.sign('HMAC', key, input.body)
	const encoded = encodeSignature(digest, input.encoding)
	return input.prefix ? `${input.prefix}${encoded}` : encoded
}

export async function verifyWebhookHmacSignature(input: {
	algorithm: WebhookHmacAlgorithm
	secret: string
	body: ArrayBuffer
	encoding: WebhookSignatureEncoding
	prefix?: string
	provided: string
}) {
	const expected = await computeWebhookHmacSignature({
		algorithm: input.algorithm,
		secret: input.secret,
		body: input.body,
		encoding: input.encoding,
		prefix: input.prefix,
	})
	return timingSafeEqualString(expected, input.provided.trim())
}

export function extractStripeSignatureParts(header: string): {
	timestampToken: string
	v1Signatures: Array<string>
} | null {
	let timestampToken: string | null = null
	const v1Signatures: Array<string> = []
	for (const part of header.split(',')) {
		const separator = part.indexOf('=')
		if (separator <= 0) continue
		const key = part.slice(0, separator).trim()
		const value = part.slice(separator + 1).trim()
		if (!value) continue
		if (key === 't' && unixIntegerPattern.test(value)) {
			timestampToken = value
			continue
		}
		if (key === 'v1') {
			v1Signatures.push(value)
		}
	}
	if (timestampToken == null) return null
	return { timestampToken, v1Signatures }
}

export function buildWebhookTimestampBodyPayload(input: {
	timestampToken: string
	body: ArrayBuffer
}): ArrayBuffer {
	const prefix = new TextEncoder().encode(`${input.timestampToken}.`)
	const bodyBytes = new Uint8Array(input.body)
	const combined = new Uint8Array(prefix.byteLength + bodyBytes.byteLength)
	combined.set(prefix, 0)
	combined.set(bodyBytes, prefix.byteLength)
	return combined.buffer
}

export async function buildWebhookDeliveryIdempotencyKey(input: {
	userId: string
	packageId: string
	webhookName: string
	deliveryId: string
}) {
	return sha256Hex(
		`${input.userId}${input.packageId}${input.webhookName}${input.deliveryId}`,
	)
}

export function isWebhookTimestampWithinTolerance(input: {
	timestampMs: number
	nowMs: number
	toleranceSeconds: number
}) {
	return (
		Math.abs(input.nowMs - input.timestampMs) <= input.toleranceSeconds * 1000
	)
}

export type ParsedWebhookReplayTimestamp =
	| { ok: true; timestampMs: number; timestampToken: string }
	| { ok: false; reason: 'missing' | 'unparseable' }

export function parseWebhookReplayTimestamp(input: {
	headerValue: string | null
	format: WebhookTimestampFormat
}): ParsedWebhookReplayTimestamp {
	const header = input.headerValue?.trim() ?? ''
	if (!header) return { ok: false, reason: 'missing' }

	switch (input.format) {
		case 'unix-seconds': {
			if (!unixIntegerPattern.test(header)) {
				return { ok: false, reason: 'unparseable' }
			}
			const seconds = Number(header)
			if (!Number.isSafeInteger(seconds)) {
				return { ok: false, reason: 'unparseable' }
			}
			return {
				ok: true,
				timestampMs: seconds * 1000,
				timestampToken: header,
			}
		}
		case 'unix-millis': {
			if (!unixIntegerPattern.test(header)) {
				return { ok: false, reason: 'unparseable' }
			}
			const millis = Number(header)
			if (!Number.isSafeInteger(millis)) {
				return { ok: false, reason: 'unparseable' }
			}
			return { ok: true, timestampMs: millis, timestampToken: header }
		}
		case 'iso-8601': {
			const timestampMs = Date.parse(header)
			if (!Number.isFinite(timestampMs)) {
				return { ok: false, reason: 'unparseable' }
			}
			return { ok: true, timestampMs, timestampToken: header }
		}
		case 'stripe-signature': {
			const parsed = extractStripeSignatureParts(header)
			if (!parsed) return { ok: false, reason: 'unparseable' }
			const seconds = Number(parsed.timestampToken)
			if (!Number.isSafeInteger(seconds)) {
				return { ok: false, reason: 'unparseable' }
			}
			return {
				ok: true,
				timestampMs: seconds * 1000,
				timestampToken: parsed.timestampToken,
			}
		}
		default: {
			const exhaustive: never = input.format
			throw new Error(
				`Unhandled webhook timestamp format: ${String(exhaustive)}`,
			)
		}
	}
}

export function providedWebhookHmacValues(input: {
	provided: string
	verificationHeader: string
	timestampHeader?: string
	timestampFormat?: WebhookTimestampFormat
}): Array<string> {
	const trimmed = input.provided.trim()
	if (
		input.timestampFormat === 'stripe-signature' &&
		input.timestampHeader &&
		input.verificationHeader.toLowerCase() ===
			input.timestampHeader.toLowerCase()
	) {
		const parsed = extractStripeSignatureParts(input.provided)
		if (parsed && parsed.v1Signatures.length > 0) {
			return parsed.v1Signatures
		}
	}
	return [trimmed]
}
