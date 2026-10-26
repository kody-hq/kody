import { auditDatabaseFromEnv, logAuditEvent } from '#worker/audit-log.ts'
import { type EmailClassification } from './types.ts'

export type EmailMessageTriageChange = {
	messageId: string
	classification?: EmailClassification
	archived?: boolean
}

/** Audit reason shared by user and admin classify / archive paths. */
export function emailMessageTriageAuditReason(
	change: EmailMessageTriageChange,
	outcome?: 'not_found',
): string {
	return [
		`target_message_id=${change.messageId}`,
		...(change.classification === undefined
			? []
			: [`classification=${change.classification}`]),
		...(change.archived === undefined ? [] : [`archived=${change.archived}`]),
		...(outcome ? [outcome] : []),
	].join(';')
}

/** Account-category audit for a person triaging their own org mailbox. */
export async function auditUserEmailMessageTriage(input: {
	env: Env
	actorEmail: string | null | undefined
	path: string
	ip?: string | null
	result: 'success' | 'failure'
	change: EmailMessageTriageChange
	outcome?: 'not_found'
}) {
	await logAuditEvent({
		db: auditDatabaseFromEnv(input.env),
		category: 'account',
		action: 'emailMessageClassify',
		result: input.result,
		email: input.actorEmail ?? undefined,
		ip: input.ip ?? undefined,
		path: input.path,
		reason: emailMessageTriageAuditReason(input.change, input.outcome),
	})
}
