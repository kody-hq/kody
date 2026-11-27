import { buildPublishHeldForApprovalEmail } from '#app/email/messages.ts'
import { resolveTransactionalEmailConfig } from '#app/email/sender-config.ts'
import { getAppBaseUrl } from '#worker/app-base-url.ts'
import { sendGatedTransactionalEmail } from '#worker/email/transactional-send-policy.ts'
import {
	loadOrgOwnerRecipientEmails,
	loadOrgSlug,
	loadOrgUsernameFallback,
} from '#worker/orgs/owner-emails.ts'
import { getSavedPackageById } from '#worker/package-registry/repo.ts'
import { buildPackageCapabilityApprovalUrl } from './capability-approval-url.ts'
import { loadHeldForApproval } from './held-for-approval.ts'

export type HeldPublishNoticeResult = {
	recipients: number
	delivered: number
}

/**
 * A publish of an internet-visible app was just held for capability
 * approval. Email the owners of the account that owns the package: whoever
 * caused the publish (an agent, a member, or an automatic republish) may not
 * be someone who can approve it. The Waiting page lists the same package
 * until it is approved. Never throws: a failed notice must not fail or retry
 * the serving update.
 */
export async function notifyOwnersOfHeldPublish(input: {
	env: Env
	ownerUserId: string
	packageId: string
}): Promise<HeldPublishNoticeResult> {
	const result: HeldPublishNoticeResult = { recipients: 0, delivered: 0 }
	try {
		const db = input.env.APP_DB
		const emailConfig = resolveTransactionalEmailConfig({ env: input.env })
		if (!db || !emailConfig) return result
		const [held, savedPackage] = await Promise.all([
			loadHeldForApproval(input),
			getSavedPackageById(db, {
				userId: input.ownerUserId,
				packageId: input.packageId,
			}),
		])
		if (!held || !savedPackage) return result
		const slug =
			(await loadOrgSlug(db, input.ownerUserId)) ??
			(await loadOrgUsernameFallback(db, input.ownerUserId))
		if (!slug) return result
		const email = buildPublishHeldForApprovalEmail({
			appBaseUrl: emailConfig.appBaseUrl,
			packageName: savedPackage.name,
			servingCommit: held.servingCommit,
			heldCommit: held.heldCommit,
			approvalUrl: buildPackageCapabilityApprovalUrl({
				baseUrl: getAppBaseUrl({ env: input.env }),
				username: slug,
				kodyId: savedPackage.kodyId,
			}),
		})
		const recipients = await loadOrgOwnerRecipientEmails(db, input.ownerUserId)
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
					kind: 'publish_held_for_approval',
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
					console.warn('publish-held-email-skipped', {
						packageId: input.packageId,
						reason: sent.error ?? 'unconfigured',
					})
				}
			} catch (error) {
				console.warn('publish-held-email-failed', {
					packageId: input.packageId,
					error,
				})
			}
		}
	} catch (error) {
		console.warn('publish-held-notice-failed', {
			packageId: input.packageId,
			error,
		})
	}
	return result
}
