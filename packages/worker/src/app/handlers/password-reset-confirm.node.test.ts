import { quoteSqlString } from '@kody-internal/shared/sql-literals.ts'
import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import type * as CloudflareEmail from '#app/email/cloudflare-email.ts'
import {
	createPasswordHash,
	verifyPassword,
} from '@kody-internal/shared/password-hash.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { logAuditEventSpy } from '#worker/test-support/audit-log-spy.ts'
import { hashPasswordResetToken } from '#worker/identity/password-reset-tokens.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'

const mockSendCloudflareEmail = vi.fn(
	async (..._args: Parameters<typeof CloudflareEmail.sendCloudflareEmail>) => ({
		ok: true,
	}),
)

vi.mock('#app/email/cloudflare-email.ts', () => ({
	sendCloudflareEmail: (
		...args: Parameters<typeof CloudflareEmail.sendCloudflareEmail>
	) => mockSendCloudflareEmail(...args),
}))

const { confirmWebsitePasswordReset } =
	await import('#worker/identity/password-reset-operations.ts')

function createMigratedDb() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../../migrations/', import.meta.url))
	return {
		sqlite,
		db: createD1FromSqlite(sqlite),
	}
}

test('password reset confirm clears TOTP, passkeys, and linked providers', async () => {
	const { sqlite, db } = createMigratedDb()
	const email = 'reset-owner@example.com'
	const passwordHash = await createPasswordHash('old-password-ok')
	const stableUserId = testStableUserIdFromEmail(email)
	const token = 'b'.repeat(64)
	const tokenHash = await hashPasswordResetToken(token)
	sqlite.exec(`
		INSERT INTO users (
			id, username, email, stable_user_id, password_hash, email_verified_at
		) VALUES (
			1,
			'reset-owner',
			${quoteSqlString(email)},
			${quoteSqlString(stableUserId)},
			${quoteSqlString(passwordHash)},
			CURRENT_TIMESTAMP
		);
		INSERT INTO verifications (
			type, target, secret, algorithm, digits, period, char_set
		) VALUES ('2fa', '1', 'RESETSECRET', 'SHA-1', 6, 30, '0123456789');
		INSERT INTO verifications (
			type, target, secret, algorithm, digits, period, char_set
		) VALUES ('2fa-verify', '1', 'PENDINGSECRET', 'SHA-1', 6, 30, '0123456789');
		INSERT INTO passkeys (
			id, aaguid, public_key, user_id, webauthn_user_handle, counter,
			device_type, backed_up, transports, name
		) VALUES (
			'reset-passkey', '00000000-0000-0000-0000-000000000000', 'cHVibGlj',
			1, 'd2ViYXV0aG4tdXNlcg', 0, 'multiDevice', 1, 'internal', 'laptop'
		);
		INSERT INTO oauth_connections (provider_name, provider_id, user_id, provider_display_name)
		VALUES ('github', 'reset-github', 1, 'reset-owner');
		INSERT INTO password_resets (user_id, token_hash, expires_at)
		VALUES (1, ${quoteSqlString(tokenHash)}, ${Date.now() + 60_000});
	`)

	const revokedGrantIds = new Array<string>()
	const env = {
		APP_DB: db,
		APP_BASE_URL: 'https://kody.codes',
		SYSTEM_EMAIL_DOMAIN: 'kody.codes',
		CLOUDFLARE_ACCOUNT_ID: 'account-id',
		CLOUDFLARE_API_BASE_URL: 'https://api.cloudflare.test',
		CLOUDFLARE_API_TOKEN: 'api-token',
		SENTRY_ENVIRONMENT: 'test',
		OAUTH_PROVIDER: {
			listUserGrants: async () => ({
				items: revokedGrantIds.includes('grant-1')
					? []
					: [{ id: 'grant-1', clientId: 'client-a' }],
			}),
			revokeGrant: async (grantId: string) => {
				revokedGrantIds.push(grantId)
			},
		},
	} as unknown as Env

	const response = await confirmWebsitePasswordReset({
		env,
		body: { token, password: 'brand-new-password' },
		request: new Request('https://kody.codes/password-reset/confirm', {
			method: 'POST',
			body: JSON.stringify({
				token,
				password: 'brand-new-password',
			}),
		}),
		url: new URL('https://kody.codes/password-reset/confirm'),
	})

	expect(response.status).toBe(200)
	expect(response.data).toEqual({ ok: true })
	expect(revokedGrantIds).toEqual(['grant-1'])

	const row = sqlite
		.prepare(`SELECT password_hash FROM users WHERE id = 1`)
		.get() as { password_hash: string }
	expect(await verifyPassword('brand-new-password', row.password_hash)).toBe(
		true,
	)
	expect(await verifyPassword('old-password-ok', row.password_hash)).toBe(false)
	expect(
		sqlite.prepare(`SELECT COUNT(*) AS count FROM password_resets`).get(),
	).toEqual({ count: 0 })
	expect(
		sqlite
			.prepare(`SELECT COUNT(*) AS count FROM verifications WHERE target = '1'`)
			.get(),
	).toEqual({ count: 0 })
	expect(
		sqlite
			.prepare(`SELECT COUNT(*) AS count FROM passkeys WHERE user_id = 1`)
			.get(),
	).toEqual({ count: 0 })
	expect(
		sqlite
			.prepare(
				`SELECT COUNT(*) AS count FROM oauth_connections WHERE user_id = 1`,
			)
			.get(),
	).toEqual({ count: 0 })
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			category: 'auth',
			action: 'password_reset_confirm',
			result: 'success',
			reason: 'two_factor=2;passkeys=1;oauth_connections=1',
		}),
	)
	const [, message] = mockSendCloudflareEmail.mock.calls[0]!
	expect((message as { to: string }).to).toBe(email)
	expect((message as { text: string }).text).toContain(
		'Two-factor authentication, passkeys, and linked sign-in providers were removed',
	)
})
