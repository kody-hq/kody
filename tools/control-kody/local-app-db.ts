const migrateLocalCommand = 'npm run migrate:local'
const seedTestDataCommand = 'node tools/seed-test-data.ts --local'

export function formatLocalAppDbRemediation() {
	return [
		'Local APP_DB looks unmigrated or unseeded. Run:',
		`  ${migrateLocalCommand}`,
		`  ${seedTestDataCommand}`,
		'Then retry: node tools/control-kody.ts login',
	].join('\n')
}

export function isLocalAppOrigin(origin: string) {
	try {
		const host = new URL(origin).hostname
		return host === 'localhost' || host === '127.0.0.1'
	} catch {
		return false
	}
}

function looksLikeUnreadyLocalAppDb(input: {
	origin: string
	status: number | null
	detail: string
	email?: string | null
	localSeedEmails: ReadonlyArray<string>
}) {
	if (!isLocalAppOrigin(input.origin)) return false
	const detail = input.detail.toLowerCase()
	if (detail.includes('no such table')) return true
	if (detail.includes('app_db') || /\bd1\b/.test(detail)) return true
	const usedLocalSeed =
		!input.email || input.localSeedEmails.includes(input.email)
	if (input.status === 401 && usedLocalSeed) return true
	return false
}

export function withLocalAppDbRemediation(
	origin: string,
	session: {
		status: number | null
		detail: string
		email?: string | null
	},
	localSeedEmails: ReadonlyArray<string>,
) {
	if (
		!looksLikeUnreadyLocalAppDb({
			origin,
			status: session.status,
			detail: session.detail,
			email: session.email,
			localSeedEmails,
		})
	) {
		return session.detail
	}
	return `${session.detail}\n${formatLocalAppDbRemediation()}`
}
