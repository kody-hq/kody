import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { createPasswordHash } from '@kody-internal/shared/password-hash.ts'
import {
	buildDeleteUserAndPersonalOrgSql,
	buildRoleAssignmentSql,
	buildSeedUserSql,
} from '../tools/seed-sql.ts'

const projectRoot = path.resolve(import.meta.dirname, '..')

function sleepSync(ms: number) {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

// Parallel Playwright workers and the test web server share one local D1
// SQLite file, so concurrent `d1 execute` calls can hit transient
// SQLITE_BUSY lock contention. Retry those with backoff.
export function executeE2eD1Command(sql: string) {
	const maxAttempts = 6
	let lastFailure = ''
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		const result = spawnSync(
			process.execPath,
			[
				'--env-file=packages/worker/.env',
				'./wrangler-env.ts',
				'd1',
				'execute',
				'APP_DB',
				'--local',
				'--persist-to',
				'.wrangler/state/e2e',
				'--command',
				sql,
			],
			{
				cwd: projectRoot,
				encoding: 'utf8',
				stdio: 'pipe',
				env: {
					...process.env,
					CLOUDFLARE_ENV: 'test',
				},
			},
		)

		if (result.status === 0) return

		lastFailure = `${result.stdout}\n${result.stderr}`
		const isLockContention =
			lastFailure.includes('SQLITE_BUSY') ||
			lastFailure.includes('database is locked')
		if (!isLockContention || attempt === maxAttempts) break
		sleepSync(150 * 2 ** (attempt - 1))
	}

	throw new Error(`Failed to execute E2E D1 command:\n${lastFailure}`)
}

export async function seedUserInE2eDatabase(input: {
	email: string
	username: string
	password: string
	admin?: boolean
}) {
	const passwordHash = await createPasswordHash(input.password)
	executeE2eD1Command(
		buildSeedUserSql({
			email: input.email,
			username: input.username,
			passwordHash,
			admin: input.admin,
		}),
	)
}

export function assignRoleInE2eDatabase(email: string, role: string) {
	executeE2eD1Command(buildRoleAssignmentSql({ email, role }))
}

export function clearAuthRateLimitsInE2eDatabase() {
	executeE2eD1Command(
		`CREATE TABLE IF NOT EXISTS _rate_limits (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			key TEXT NOT NULL,
			ts INTEGER NOT NULL
		);
		DELETE FROM _rate_limits WHERE key LIKE 'auth:ip:%' OR key LIKE 'guest-create:%';`,
	)
}

export function deleteUserInE2eDatabase(email: string) {
	const sql = buildDeleteUserAndPersonalOrgSql({ emails: [email] })
	if (!sql) return
	executeE2eD1Command(sql)
}
