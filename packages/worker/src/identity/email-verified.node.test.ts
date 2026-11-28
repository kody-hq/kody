import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'

const workerSrc = fileURLToPath(new URL('..', import.meta.url))

// Each file that writes users.email_verified_at, mapped to the files that run
// `onEmailVerified` after that write commits. Inserts that create a new
// account are not listed: no referral can be held on a person who did not
// exist yet.
const writersToSteps: Record<string, Array<string>> = {
	'app/email-change.ts': ['app/handlers/verify-email-change.ts'],
	'app/email-verification.ts': ['app/handlers/verify-email.ts'],
	'app/handlers/auth-provider.ts': ['app/handlers/auth-provider.ts'],
	'guest/guest-claim.ts': ['guest/guest-claim.ts'],
	'identity/email-verification-admin.ts': [
		'admin/users-operations.ts',
		'mcp/capabilities/admin/admin-user-verify.ts',
	],
}

function sourceFiles(dir: string): Array<string> {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name)
		if (entry.isDirectory()) {
			// Dot directories are lint-rule test fixtures that other tests create
			// and delete while this walk runs.
			return entry.name === 'test-support' || entry.name.startsWith('.')
				? []
				: sourceFiles(path)
		}
		if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) {
			return []
		}
		if (entry.name.endsWith('test-schema.ts')) return []
		return [path]
	})
}

test('every email_verified_at write runs the shared onEmailVerified step', () => {
	const writers = sourceFiles(workerSrc)
		.filter((path) =>
			/\bemail_verified_at\s*=\s*(?!NULL\b)/i.test(readFileSync(path, 'utf8')),
		)
		.map((path) => relative(workerSrc, path).replaceAll('\\', '/'))
		.sort()
	expect(writers).toEqual(Object.keys(writersToSteps).sort())
	for (const steps of Object.values(writersToSteps)) {
		for (const step of steps) {
			expect(
				readFileSync(join(workerSrc, step), 'utf8'),
				`${step} must await onEmailVerified`,
			).toMatch(/await onEmailVerified\(/)
		}
	}
})
