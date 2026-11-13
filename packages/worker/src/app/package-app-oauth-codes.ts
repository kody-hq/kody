import { timingSafeEqualString } from '@kody-internal/shared/timing-safe.ts'
import { sha256Base64Url } from '@kody-internal/shared/sha256.ts'
import { bytesToBase64Url } from '@kody-internal/shared/base64.ts'
import {
	serializePackageAppOauthScopes,
	type PackageAppOauthScope,
} from '#app/package-app-oauth-scopes.ts'

const codeTtlMs = 60_000

export type PackageAppOauthCodeRecord = {
	personId: string
	username: string
	orgUsername: string
	kodyId: string
	redirectUri: string
	codeChallenge: string
	scopes: Array<PackageAppOauthScope>
	sessionExpiresAt: number
	exp: number
}

function randomCodePlaintext() {
	const bytes = new Uint8Array(32)
	crypto.getRandomValues(bytes)
	return bytesToBase64Url(bytes)
}

/** Drop expired authorization codes (index-backed). Called on mint. */
export async function deleteExpiredPackageAppOauthCodes(input: {
	env: Env
	now?: number
}) {
	const now = input.now ?? Date.now()
	await input.env.APP_DB.prepare(
		`DELETE FROM package_app_oauth_codes WHERE expires_at <= ?`,
	)
		.bind(new Date(now).toISOString())
		.run()
}

export async function mintPackageAppOauthCode(input: {
	env: Env
	record: Omit<PackageAppOauthCodeRecord, 'exp'>
	now?: number
}): Promise<{ code: string; expiresAt: number } | null> {
	const now = input.now ?? Date.now()
	await deleteExpiredPackageAppOauthCodes({ env: input.env, now })
	const code = randomCodePlaintext()
	const exp = now + codeTtlMs
	const hash = await sha256Base64Url(code)
	const payload = JSON.stringify({
		...input.record,
		exp,
	} satisfies PackageAppOauthCodeRecord)
	await input.env.APP_DB.prepare(
		`INSERT INTO package_app_oauth_codes
		 (code_hash, payload, expires_at, created_at)
		 VALUES (?, ?, ?, ?)`,
	)
		.bind(
			hash,
			payload,
			new Date(exp).toISOString(),
			new Date(now).toISOString(),
		)
		.run()
	return { code, expiresAt: exp }
}

export async function consumePackageAppOauthCode(input: {
	env: Env
	code: string
	redirectUri: string
	codeVerifier: string
	now?: number
}): Promise<PackageAppOauthCodeRecord | null> {
	const now = input.now ?? Date.now()
	const hash = await sha256Base64Url(input.code)
	// Atomic single-use: only one concurrent DELETE wins and receives the row.
	const deleted = await input.env.APP_DB.prepare(
		`DELETE FROM package_app_oauth_codes
		 WHERE code_hash = ? AND expires_at > ?
		 RETURNING payload`,
	)
		.bind(hash, new Date(now).toISOString())
		.first<{ payload: string }>()
	if (!deleted?.payload) return null

	let record: PackageAppOauthCodeRecord
	try {
		record = JSON.parse(deleted.payload) as PackageAppOauthCodeRecord
	} catch {
		return null
	}
	if (!record || typeof record !== 'object') return null
	if (record.exp <= now) return null
	if (record.redirectUri !== input.redirectUri) return null
	const challenge = await sha256Base64Url(input.codeVerifier)
	if (!(await timingSafeEqualString(challenge, record.codeChallenge))) {
		return null
	}
	return record
}

export function packageAppOauthCodeScopesLabel(
	scopes: ReadonlyArray<PackageAppOauthScope>,
) {
	return serializePackageAppOauthScopes(scopes)
}
