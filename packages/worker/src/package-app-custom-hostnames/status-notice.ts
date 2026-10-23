import {
	buildCustomDomainActiveEmail,
	buildCustomDomainNeedsAttentionEmail,
} from '#app/email/messages.ts'
import { resolveTransactionalEmailConfig } from '#app/email/sender-config.ts'
import { joinAppUrl } from '#worker/app-base-url.ts'
import { sendGatedTransactionalEmail } from '#worker/email/transactional-send-policy.ts'
import {
	loadOrgOwnerRecipientEmails,
	loadOrgSlug,
	loadOrgUsernameFallback,
} from '#worker/orgs/owner-emails.ts'
import {
	describePackageAppCustomDomainStatus,
	isPackageAppCustomDomainFailedStatus,
} from '#universal/package-app-custom-domain-status.ts'
import { routes } from '#universal/routes.ts'
import { type PackageAppCustomHostnameRow } from '#worker/package-app-custom-hostnames/types.ts'

export type CustomHostnameStatusNoticeEvent = 'active' | 'needs_attention'

export type CustomHostnameStatusNoticeResult = {
	recipients: number
	delivered: number
}

async function resolveOwner(db: D1Database, row: PackageAppCustomHostnameRow) {
	if (row.orgId) return { ownerId: row.orgId, kodyId: null }
	if (!row.packageId) return null
	const saved = await db
		.prepare(
			`SELECT user_id, kody_id FROM saved_packages WHERE id = ? AND deleted_at IS NULL`,
		)
		.bind(row.packageId)
		.first<{ user_id: string; kody_id: string }>()
	if (!saved) return null
	return { ownerId: saved.user_id, kodyId: saved.kody_id }
}

/**
 * Email the owners of the package (app binding) or organization (org
 * binding) when Kody's own re-check finds a custom hostname active, or gives
 * up on one that never went active. Never throws: a failed notice must not
 * fail the sync or the reconcile tick.
 */
export async function notifyOwnersOfCustomHostnameStatus(input: {
	env: Env
	row: PackageAppCustomHostnameRow
	event: CustomHostnameStatusNoticeEvent
}): Promise<CustomHostnameStatusNoticeResult> {
	const result: CustomHostnameStatusNoticeResult = {
		recipients: 0,
		delivered: 0,
	}
	console.info('package-app-custom-hostname-status-notice', {
		id: input.row.id,
		event: input.event,
	})
	try {
		const db = input.env.APP_DB
		const emailConfig = resolveTransactionalEmailConfig({ env: input.env })
		if (!db || !emailConfig) return result
		const owner = await resolveOwner(db, input.row)
		if (!owner) return result
		const slug =
			(await loadOrgSlug(db, owner.ownerId)) ??
			(await loadOrgUsernameFallback(db, owner.ownerId))
		const manageUrl = slug
			? owner.kodyId
				? joinAppUrl({
						env: input.env,
						path: routes.communityPackageSettings.href({
							username: slug,
							kodyId: owner.kodyId,
						}),
					})
				: joinAppUrl({
						env: input.env,
						path: routes.orgSettings.href({ orgSlug: slug }),
					})
			: joinAppUrl({ env: input.env, path: '/account' })
		const email =
			input.event === 'active'
				? buildCustomDomainActiveEmail({
						appBaseUrl: emailConfig.appBaseUrl,
						hostname: input.row.hostname,
						servesLabel: owner.kodyId
							? `the app ${owner.kodyId}`
							: 'your organization’s private apps',
						openUrl:
							input.row.bindingKind === 'app'
								? `https://${input.row.hostname}/`
								: manageUrl,
						openLabel:
							input.row.bindingKind === 'app'
								? 'Open the app'
								: 'Review custom domains',
					})
				: buildCustomDomainNeedsAttentionEmail({
						appBaseUrl: emailConfig.appBaseUrl,
						hostname: input.row.hostname,
						reason:
							describePackageAppCustomDomainStatus(input.row).reason ??
							'The hostname is not active yet.',
						cause: isPackageAppCustomDomainFailedStatus(input.row)
							? 'failed'
							: 'timed_out',
						manageUrl,
						docsUrl: joinAppUrl({
							env: input.env,
							path: '/docs/package-app-custom-domains',
						}),
					})
		const recipients = await loadOrgOwnerRecipientEmails(db, owner.ownerId)
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
					kind: 'custom_domain_status',
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
					console.warn('package-app-custom-hostname-notice-skipped', {
						id: input.row.id,
						reason: sent.error ?? 'unconfigured',
					})
				}
			} catch (error) {
				console.warn('package-app-custom-hostname-notice-failed', {
					id: input.row.id,
					error,
				})
			}
		}
	} catch (error) {
		console.warn('package-app-custom-hostname-notice-failed', {
			id: input.row.id,
			error,
		})
	}
	return result
}
