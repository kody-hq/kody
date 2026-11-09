import { isExecutedDirectly } from '../node-runtime.ts'
import { runBackupResourcesCli } from './backup-resources-cli.ts'
import type { AdhocBackupPolicyProof } from './backup-resources.ts'

type ReconciliationResult =
	| {
			status: 'skipped'
			reason: 'dr-backup-admin-token-unavailable'
	  }
	| {
			status: 'reconciled'
			adhocPolicyProof: AdhocBackupPolicyProof
	  }

type ApplyBackupResources = (input: {
	argv: ReadonlyArray<string>
	env: Readonly<Record<string, string | undefined>>
	log?: (output: string) => void
}) => Promise<{
	status: 'planned' | 'applied'
	adhocPolicyProof?: AdhocBackupPolicyProof
}>

export async function reconcileBackupResources(input: {
	env: Readonly<Record<string, string | undefined>>
	log?: (output: string) => void
	apply?: ApplyBackupResources
}): Promise<ReconciliationResult> {
	const log = input.log ?? console.log
	const adminToken = input.env.DR_BACKUP_ADMIN_TOKEN?.trim()
	if (!adminToken) {
		log(
			'DR backup policy reconciliation skipped: DR_BACKUP_ADMIN_TOKEN is unavailable. Existing bucket policies remain unchanged.',
		)
		return {
			status: 'skipped',
			reason: 'dr-backup-admin-token-unavailable',
		}
	}
	const result = await (input.apply ?? runBackupResourcesCli)({
		argv: ['apply'],
		env: {
			...input.env,
			CLOUDFLARE_API_TOKEN: adminToken,
		},
		log,
	})
	if (
		result.status !== 'applied' ||
		result.adhocPolicyProof?.readBackVerified !== true ||
		result.adhocPolicyProof.prefix !== 'adhoc/'
	) {
		throw new Error(
			'DR backup policy reconciliation did not produce a verified adhoc/ read-back proof.',
		)
	}
	log(
		'DR backup policy reconciliation complete: live adhoc/ lock and lifecycle read-back verified.',
	)
	return {
		status: 'reconciled',
		adhocPolicyProof: result.adhocPolicyProof,
	}
}

async function main() {
	try {
		await reconcileBackupResources({ env: process.env })
	} catch (error) {
		const message =
			error instanceof Error
				? error.message
				: 'DR backup policy reconciliation failed.'
		console.error(message)
		process.exitCode = 1
	}
}

if (isExecutedDirectly(import.meta.url)) {
	await main()
}
