import { buildJobAutoDisabledEmail } from '#app/email/messages.ts'
import { resolveTransactionalEmailConfig } from '#app/email/sender-config.ts'
import { joinAppUrl } from '#worker/app-base-url.ts'
import { sendGatedTransactionalEmail } from '#worker/email/transactional-send-policy.ts'
import {
	loadOrgOwnerRecipientEmails,
	loadOrgSlug,
	loadOrgUsernameFallback,
} from '#worker/orgs/owner-emails.ts'
import { routes } from '#universal/routes.ts'

export type JobAutoDisabledNoticeResult = {
	recipients: number
	delivered: number
}

/**
 * Kody turned a recurring job off on its own (it could not compute the next
 * run). Log the reason and email the org owners, since nobody on the account
 * made the change and the job stays off until they act. Never throws: a
 * failed notice must not undo or retry the scheduler transition.
 */
export async function notifyOwnersOfJobAutoDisabled(input: {
	env: Env
	ownerId: string
	jobId: string
	jobName: string
	reason: string
}): Promise<JobAutoDisabledNoticeResult> {
	console.warn('job-auto-disabled', {
		ownerId: input.ownerId,
		jobId: input.jobId,
		reason: input.reason,
	})
	const result: JobAutoDisabledNoticeResult = { recipients: 0, delivered: 0 }
	try {
		const db = input.env.APP_DB
		const emailConfig = resolveTransactionalEmailConfig({ env: input.env })
		if (!db || !emailConfig) return result
		const slug =
			(await loadOrgSlug(db, input.ownerId)) ??
			(await loadOrgUsernameFallback(db, input.ownerId))
		const jobsPath = slug ? `/@${slug}/-/jobs` : '/account/jobs'
		const email = buildJobAutoDisabledEmail({
			appBaseUrl: emailConfig.appBaseUrl,
			jobsUrl: joinAppUrl({ env: input.env, path: jobsPath }),
			supportUrl: joinAppUrl({ env: input.env, path: routes.support.href() }),
			ownerLabel: slug ? `@${slug}` : 'your account',
			jobName: input.jobName,
			reason: input.reason,
		})
		const recipients = await loadOrgOwnerRecipientEmails(db, input.ownerId)
		result.recipients = recipients.length
		for (const recipient of recipients) {
			try {
				const sent = await sendGatedTransactionalEmail({
					db,
					config: {
						accountId: input.env.CLOUDFLARE_ACCOUNT_ID,
						apiBaseUrl: input.env.CLOUDFLARE_API_BASE_URL,
						apiToken: input.env.CLOUDFLARE_API_TOKEN,
					},
					category: 'holdable',
					kind: 'job_auto_disabled',
					message: {
						to: recipient.email,
						from: emailConfig.fromEmail,
						subject: email.subject,
						html: email.html,
						text: email.text,
					},
				})
				if (sent.ok) result.delivered += 1
				else {
					console.warn('job-auto-disabled-email-skipped', {
						ownerId: input.ownerId,
						jobId: input.jobId,
						reason: sent.error ?? 'unconfigured',
					})
				}
			} catch (error) {
				console.warn('job-auto-disabled-email-failed', {
					ownerId: input.ownerId,
					jobId: input.jobId,
					error,
				})
			}
		}
	} catch (error) {
		console.warn('job-auto-disabled-notice-failed', {
			ownerId: input.ownerId,
			jobId: input.jobId,
			error,
		})
	}
	return result
}
