import { BackupError } from './backup-policy.ts'
import type { BackupEnvironment } from './backup-types.ts'

export function assertDrillAccountIsolated(env: BackupEnvironment): void {
	const drillAccountId = env.DRILL_ACCOUNT_ID?.trim()
	if (!drillAccountId) {
		throw new BackupError(
			'drill-account-missing',
			'DRILL_ACCOUNT_ID is required',
		)
	}
	if (drillAccountId.toLowerCase() === env.SOURCE_ACCOUNT_ID.toLowerCase()) {
		throw new BackupError(
			'drill-account-not-isolated',
			'DRILL_ACCOUNT_ID must differ from SOURCE_ACCOUNT_ID',
		)
	}
}

export function requireDrillToken(env: BackupEnvironment): string {
	const token = env.DRILL_API_TOKEN?.trim()
	if (!token) {
		throw new BackupError('drill-token-missing', 'DRILL_API_TOKEN is required')
	}
	return token
}
