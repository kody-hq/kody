import {
	packageScopeFromNameOrOwner,
	packageSettingsHrefFromScope,
} from '#universal/community-links.ts'
import { type PackageWebhookListItem } from '#universal/loader-data.ts'
import { docHref } from '#universal/docs-nav.ts'
import { colors } from '#universal/styles/tokens.ts'

/** The triggers guide section on inbound webhooks (`docs/guides/triggers.md`). */
export const webhooksDocHref = `${docHref('triggers')}#inbound-webhooks-the-external-http-knock`

export type WebhookIntent = 'mint' | 'rotate' | 'reveal'

/**
 * Declared count is unique package+name pairs (account index) or unique names
 * (one-package Settings). List rows may still be one per minted URL.
 */
export function webhookDeclaredCount(
	webhooks: ReadonlyArray<{ name: string; packageKodyId?: string }>,
) {
	return new Set(
		webhooks.map((webhook) =>
			webhook.packageKodyId
				? `${webhook.packageKodyId}/${webhook.name}`
				: webhook.name,
		),
	).size
}

/** Anchor of the Webhooks section on package settings. */
export const packageWebhooksSectionId = 'webhooks'

/** Anchor of one webhook's card inside that section. */
export function packageWebhookCardId(input: {
	webhookName: string
	endpointId?: string | null
}) {
	return input.endpointId
		? `webhook-${input.webhookName}-${input.endpointId}`
		: `webhook-${input.webhookName}`
}

/**
 * Package settings is where URLs get minted and copied; the account index
 * and any "manage this webhook" link land on the owning package's section
 * (or one webhook's card when the name / endpoint is known). Owner always
 * comes from the package's scoped name (`@owner/kody-id`), not the viewer.
 */
export function buildPackageWebhooksHref(input: {
	packageName: string
	kodyId?: string | null
	/** Fallback when `packageName` is not scoped (should not happen for saved packages). */
	ownerUsername?: string | null
	webhookName?: string | null
	endpointId?: string | null
}) {
	const scope = packageScopeFromNameOrOwner({
		packageName: input.packageName,
		ownerUsername: input.ownerUsername,
		kodyId: input.kodyId,
	})
	if (!scope) return '#'
	const settingsHref = packageSettingsHrefFromScope(scope)
	const anchor = input.webhookName
		? packageWebhookCardId({
				webhookName: input.webhookName,
				endpointId: input.endpointId,
			})
		: packageWebhooksSectionId
	return `${settingsHref}#${anchor}`
}

type WebhookStatusInput = Pick<PackageWebhookListItem, 'minted' | 'approved'>

export function webhookStatusLabel(webhook: WebhookStatusInput) {
	if (!webhook.minted) return 'No URL yet'
	if (!webhook.approved) return 'Needs approval'
	return 'Approved'
}

export function webhookStatusColor(webhook: WebhookStatusInput) {
	if (!webhook.minted) return colors.textMuted
	if (!webhook.approved) return colors.warningText
	return colors.primary
}

export function webhookModeLabel(
	webhook: Pick<PackageWebhookListItem, 'responseMode' | 'inputMode'>,
) {
	return `${webhook.responseMode} · ${webhook.inputMode}`
}

export function webhookVerificationLabel(
	webhook: Pick<PackageWebhookListItem, 'verification'>,
) {
	if (!webhook.verification || webhook.verification.type === 'url-secret') {
		return 'URL secret only'
	}
	return `${webhook.verification.type} · ${webhook.verification.header}`
}

const approveStillRequired =
	' It will not run until you Approve it: use the Approve link on this card.'

export function webhookSuccessMessage(
	intent: WebhookIntent,
	approvalUrl?: string | null,
) {
	switch (intent) {
		case 'mint':
			return `Webhook URL minted. Copy it now and paste it into the provider.${approvalUrl ? approveStillRequired : ''}`
		case 'rotate':
			return `Webhook URL rotated. The previous URL stays active until the new one receives a delivery, or for 24 hours.${approvalUrl ? approveStillRequired : ''}`
		case 'reveal':
			return null
		default: {
			const exhaustive: never = intent
			return String(exhaustive)
		}
	}
}

export function webhookFailureMessage(intent: WebhookIntent) {
	switch (intent) {
		case 'mint':
			return 'Unable to mint the webhook URL.'
		case 'rotate':
			return 'Unable to rotate the webhook URL.'
		case 'reveal':
			return 'Unable to reveal the webhook URL.'
		default: {
			const exhaustive: never = intent
			return String(exhaustive)
		}
	}
}
