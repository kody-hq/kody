import {
	base64UrlToBytes,
	bytesToBase64Url,
} from '@kody-internal/shared/base64.ts'
import { timingSafeEqualString } from '@kody-internal/shared/timing-safe.ts'

import { BackupError } from './backup-policy.ts'
import type { BackupEnvironment } from './backup-types.ts'

const RESTORE_CONFIRM_TTL_MS = 10 * 60 * 1000

function requireSecret(env: BackupEnvironment): string {
	const secret = env.RESTORE_CONFIRM_SECRET?.trim()
	if (!secret) {
		throw new BackupError(
			'restore-confirm-secret-missing',
			'RESTORE_CONFIRM_SECRET is required',
		)
	}
	return secret
}

async function hmacSha256(
	secret: string,
	message: string,
): Promise<Uint8Array> {
	const key = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign'],
	)
	return new Uint8Array(
		await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message)),
	)
}

export type RestoreConfirmToken = {
	day: string
	expiresAt: string
	token: string
}

export async function issueRestoreConfirmToken(
	env: BackupEnvironment,
	day: string,
	now: Date = new Date(),
): Promise<RestoreConfirmToken> {
	const secret = requireSecret(env)
	const expiresAt = new Date(
		now.valueOf() + RESTORE_CONFIRM_TTL_MS,
	).toISOString()
	const mac = await hmacSha256(secret, `restore:${day}:${expiresAt}`)
	return {
		day,
		expiresAt,
		token: bytesToBase64Url(mac),
	}
}

export async function verifyRestoreConfirmToken(
	env: BackupEnvironment,
	input: { day: string; expiresAt: string; token: string },
	now: Date = new Date(),
): Promise<void> {
	const secret = requireSecret(env)
	if (!Number.isFinite(Date.parse(input.expiresAt))) {
		throw new BackupError(
			'restore-confirm-expired',
			'restore confirmation token expiry is invalid',
		)
	}
	if (Date.parse(input.expiresAt) <= now.valueOf()) {
		throw new BackupError(
			'restore-confirm-expired',
			'restore confirmation token has expired',
		)
	}
	const expected = bytesToBase64Url(
		await hmacSha256(secret, `restore:${input.day}:${input.expiresAt}`),
	)
	if (!(await timingSafeEqualString(expected, input.token))) {
		throw new BackupError(
			'restore-confirm-invalid',
			'restore confirmation token is invalid',
		)
	}
	// Reject obviously malformed base64url tokens even if compare somehow passed.
	try {
		base64UrlToBytes(input.token)
	} catch {
		throw new BackupError(
			'restore-confirm-invalid',
			'restore confirmation token is invalid',
		)
	}
}
