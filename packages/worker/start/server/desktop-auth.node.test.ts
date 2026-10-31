import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { test, expect, vi, beforeEach } from 'vitest'
import { desktopAuthHash } from '#app/desktop-auth-request.ts'
const state = vi.hoisted(() => ({ env: {} as Env, audit: vi.fn() }))
vi.mock('./request-env.ts', () => ({ getStartRequestEnv: () => state.env }))
vi.mock('./mutation-context.ts', () => ({
	withWebsiteRead: vi.fn(),
	withWebsiteMutation: vi.fn(),
}))
vi.mock('./auth-mutation-context.ts', () => ({ publicAuthContext: vi.fn() }))
vi.mock('#app/authenticated-user.ts', () => ({
	readAuthenticatedAppUser: vi.fn(),
}))
vi.mock('#worker/audit-log.ts', () => ({
	auditDatabaseFromEnv: vi.fn(),
	getRequestIp: () => undefined,
	logAuditEvent: state.audit,
}))
import { desktopSessionHttp } from './desktop-auth.ts'
let db: DatabaseSync
const code = 'c'.repeat(43)
const verifier = 'v'.repeat(43)
beforeEach(async () => {
	state.audit.mockReset().mockResolvedValue(undefined)
	db = new DatabaseSync(':memory:')
	db.exec(
		readFileSync(
			new URL(
				'../../migrations/0215-desktop-browser-login.sql',
				import.meta.url,
			),
			'utf8',
		),
	)
	db.exec(
		'CREATE TABLE users (stable_user_id TEXT, email TEXT, password_changed_at TEXT, deleted_at TEXT, deleting_at TEXT, suspended_at TEXT)',
	)
	db.prepare('INSERT INTO users (stable_user_id,email) VALUES (?,?)').run(
		'a'.repeat(64),
		'test@example.com',
	)
	const now = Date.now()
	db.prepare(
		'INSERT INTO desktop_login_grants VALUES (?, ?, ?, ?, ?, ?, ?)',
	).run(
		await desktopAuthHash(code),
		await desktopAuthHash(verifier),
		'a'.repeat(64),
		now - 10_000,
		now + 60_000,
		0,
		now + 60_000,
	)
	state.env = {
		COOKIE_SECRET: 'test-only-secret-0123456789abcdef0123456789',
		APP_DB: {
			prepare: (sql: string) => ({
				bind: (...values: Array<string | number>) => ({
					first: async () => db.prepare(sql).get(...values) ?? null,
				}),
			}),
		},
	} as unknown as Env
})
function redeem(
	body: unknown = { code, verifier },
	headers: Record<string, string> = {},
) {
	return desktopSessionHttp({
		request: new Request('https://kody.test/desktop/session', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', ...headers },
			body: JSON.stringify(body),
		}),
	})
}
test('PKCE rejects a wrong verifier without consuming the code, success sets only an HttpOnly cookie and replay fails', async () => {
	expect((await redeem({ code, verifier: 'w'.repeat(43) })).status).toBe(400)
	const success = await redeem()
	expect(success.status).toBe(204)
	expect(success.headers.get('Set-Cookie')).toMatch(/^kody_session=.*HttpOnly/i)
	expect(success.headers.get('Set-Cookie')).toContain('Secure')
	expect(await success.text()).toBe('')
	expect((await redeem()).status).toBe(400)
	db.close()
})
test.each(['expires_at', 'session_expires_at'])(
	'expired %s cannot create a session',
	async (column) => {
		db.exec(`UPDATE desktop_login_grants SET ${column} = 0`)
		expect((await redeem()).status).toBe(400)
		db.close()
	},
)
test.each(['deleted_at', 'deleting_at', 'suspended_at', 'password_changed_at'])(
	'%s blocks a pending handoff',
	async (column) => {
		db.prepare(`UPDATE users SET ${column} = ?`).run(new Date().toISOString())
		expect((await redeem()).status).toBe(400)
		db.close()
	},
)
test('cross-origin and non-JSON redemption fail before consuming a grant', async () => {
	expect(
		(await redeem(undefined, { Origin: 'https://evil.test' })).status,
	).toBe(400)
	expect(
		(await redeem(undefined, { 'Content-Type': 'text/plain' })).status,
	).toBe(400)
	expect((await redeem()).status).toBe(204)
	db.close()
})

test('the login response waits for its audit write', async () => {
	let finishAudit: (() => void) | undefined
	state.audit.mockImplementation(
		() =>
			new Promise<void>((resolve) => {
				finishAudit = resolve
			}),
	)
	let completed = false
	const response = redeem().then((response) => {
		completed = true
		return response
	})
	await vi.waitFor(() => expect(state.audit).toHaveBeenCalledOnce())
	expect(completed).toBe(false)
	finishAudit!()
	expect((await response).status).toBe(204)
	db.close()
})
