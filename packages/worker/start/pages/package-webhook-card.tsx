/** @jsxImportSource @emotion/react */
import { type CSSObject } from '@emotion/react'

import { SiteLink } from '../components/site-link.tsx'

import {
	AccountManagementMessage,
	IdValue,
	MetadataGrid,
	TimestampValue,
	noticeCardCss,
} from './account-management-components.tsx'
import {
	packageWebhookCardId,
	type WebhookIntent,
	webhookModeLabel,
	webhookStatusColor,
	webhookStatusLabel,
	webhooksDocHref,
} from '#client/routes/webhooks-shared.ts'
import { CopyCard } from './onboarding-mcp-client-cards.tsx'
import { type PackageWebhookListItem } from '#universal/loader-data.ts'
import {
	descriptionCss,
	fieldCss,
	fieldLabelCss,
	getDangerPillCss,
	getGhostButtonCss,
	getPillButtonCss,
	mutedLinkCss,
	primaryLinkCss,
} from '#universal/styles/style-primitives.ts'
import { colors, spacing, typography } from '#universal/styles/tokens.ts'

const primaryButtonCss = getPillButtonCss({ size: 'sm' })
const secondaryButtonCss = getGhostButtonCss({ size: 'sm' })
const dangerButtonCss = getDangerPillCss({ size: 'sm' })

export type WebhookConfirmation = {
	armed: boolean
	onClick: () => void
	onBlur: () => void
}

const cardCss = {
	...noticeCardCss,
	// The card is a hash target from the account index; give the jump some
	// breathing room above the heading.
	scrollMarginTop: spacing.xl,
} satisfies CSSObject

const cardHeadCss = {
	display: 'flex',
	alignItems: 'baseline',
	justifyContent: 'space-between',
	gap: spacing.md,
	flexWrap: 'wrap' as const,
} satisfies CSSObject

const cardTitleCss = {
	margin: 0,
	fontSize: typography.fontSize.lg,
	fontWeight: typography.fontWeight.semibold,
	color: colors.text,
	fontFamily: 'monospace',
} satisfies CSSObject

const statusPillCss = {
	fontSize: typography.fontSize.sm,
	fontWeight: typography.fontWeight.semibold,
	whiteSpace: 'nowrap' as const,
} satisfies CSSObject

function verificationValue(webhook: PackageWebhookListItem) {
	const verification = webhook.verification
	if (!verification) {
		return (
			<span css={{ display: 'grid', gap: spacing.xs }}>
				<span>URL secret only (no HMAC; not declared)</span>
				<span css={{ color: colors.textMuted }}>
					Works as is. Optionally declare{' '}
					<code>{'verification: { "type": "url-secret" }'}</code>, or an HMAC
					type if the sender signs.
				</span>
			</span>
		)
	}
	if (verification.type === 'url-secret') return 'URL secret only (no HMAC)'
	return (
		<span css={{ display: 'grid', gap: spacing.xs }}>
			<span>
				{verification.type} · <code>{verification.header}</code>
			</span>
			<span css={{ color: colors.textMuted }}>
				{verification.secretName ? (
					<>
						secret <code>{verification.secretName}</code>
					</>
				) : (
					'package-owned HMAC'
				)}
				{verification.prefix ? ` · prefix ${verification.prefix}` : ''}
				{verification.signedPayload === 'timestamp.body'
					? ' · signs timestamp.body'
					: ''}
			</span>
		</span>
	)
}

function replayValue(webhook: PackageWebhookListItem) {
	const replay = webhook.replay
	if (!replay) return 'Not configured'
	const parts: Array<string> = []
	if (replay.deliveryIdHeader) {
		parts.push(`delivery id ${replay.deliveryIdHeader}`)
	}
	if (replay.timestampHeader) {
		parts.push(
			`timestamp ${replay.timestampHeader} (${replay.toleranceSeconds ?? 300}s)`,
		)
	}
	return parts.length > 0 ? parts.join(' · ') : 'Not configured'
}

function challengeSecretName(
	challenge: NonNullable<PackageWebhookListItem['challenge']>,
) {
	const prove = challenge.prove
	if (!prove || prove.kind === 'none') return undefined
	return prove.secretName
}

function challengeValue(webhook: PackageWebhookListItem) {
	const challenge = webhook.challenge
	if (!challenge) return 'Not configured'
	const secretName = challengeSecretName(challenge)
	return (
		<span css={{ display: 'grid', gap: spacing.xs }}>
			<span>
				<code>{challenge.type}</code>
			</span>
			{secretName ? (
				<span css={{ color: colors.textMuted }}>
					secret <code>{secretName}</code>
				</span>
			) : null}
		</span>
	)
}

/**
 * One declared webhook on package settings: metadata, the URL slot (Mint /
 * Reveal + Copy / Hide), Approve until a person approves it, then the Rotate
 * and Enable / Disable actions. The
 * card never renders a URL it did not just receive from a reveal.
 */
export type PackageWebhookCardIntent = {
	intent: WebhookIntent
	createInstance?: boolean
	instanceLabel?: string
}

export function renderPackageWebhookCard(input: {
	webhook: PackageWebhookListItem
	revealedUrl: string | null
	isMutating: boolean
	rotateCheck: WebhookConfirmation
	disableCheck: WebhookConfirmation
	onIntent: (payload: PackageWebhookCardIntent) => void
	onHideUrl: () => void
	deliveriesHref: string
	/** Show “Mint another URL” when this card is the first minted sibling. */
	showMintAnother?: boolean
}) {
	const {
		webhook,
		revealedUrl,
		isMutating,
		rotateCheck,
		disableCheck,
		onIntent,
		onHideUrl,
		showMintAnother = false,
	} = input
	const webhookLabel = `${webhook.packageKodyId}/${webhook.name}`
	const cardDomId = packageWebhookCardId({
		webhookName: webhook.name,
		endpointId: webhook.endpointId,
	})
	const titleId = `${cardDomId}-title`
	const titleText = webhook.instanceLabel
		? `${webhook.name} · ${webhook.instanceLabel}`
		: webhook.name
	return (
		<article
			id={cardDomId}
			aria-labelledby={titleId}
			css={cardCss}
			data-testid="package-webhook-card"
			data-webhook-id={webhook.id}
		>
			<div css={{ display: 'grid', gap: spacing.xs }}>
				<div css={cardHeadCss}>
					<h3 id={titleId} css={cardTitleCss}>
						{titleText}
					</h3>
					<span css={{ ...statusPillCss, color: webhookStatusColor(webhook) }}>
						{webhookStatusLabel(webhook)}
					</span>
				</div>
				<p css={descriptionCss}>
					{webhook.description ??
						`Each delivery runs the bound export ${webhook.exportName}.`}
				</p>
			</div>

			<MetadataGrid
				items={[
					{
						label: 'Export',
						value: <code>{webhook.exportName}</code>,
					},
					{ label: 'Mode', value: webhookModeLabel(webhook) },
					{
						label: 'Rate limit',
						value: `${webhook.rateLimitPerMinute} / min`,
					},
					{ label: 'Verification', value: verificationValue(webhook) },
					{ label: 'Challenge', value: challengeValue(webhook) },
					{ label: 'Replay protection', value: replayValue(webhook) },
					{
						label: 'Handle',
						value: webhook.handle ? (
							<IdValue value={webhook.handle} label="webhook handle" />
						) : (
							'—'
						),
					},
					{ label: 'URL host', value: webhook.urlHost ?? '—' },
					{
						label: 'Minted',
						value: <TimestampValue value={webhook.createdAt} />,
					},
					{
						label: 'Rotated',
						value: <TimestampValue value={webhook.rotatedAt} />,
					},
					...(webhook.enabled && webhook.previousUrlActiveUntil
						? [
								{
									label: 'Previous URL',
									value: (
										<span>
											active until{' '}
											<TimestampValue value={webhook.previousUrlActiveUntil} />
										</span>
									),
								},
							]
						: []),
				]}
			/>

			<div css={fieldCss} data-testid="package-webhook-url">
				<span css={fieldLabelCss}>Webhook URL</span>
				{renderUrlSection({
					webhook,
					revealedUrl,
					isMutating,
					onIntent,
					onHideUrl,
				})}
			</div>

			{webhook.minted ? (
				<div
					css={{
						display: 'flex',
						gap: spacing.sm,
						flexWrap: 'wrap',
						alignItems: 'center',
					}}
				>
					{!webhook.approved ? (
						webhook.approvalUrl ? (
							<SiteLink
								href={webhook.approvalUrl}
								aria-label={`Approve ${webhookLabel}`}
								data-testid="package-webhook-approve"
								css={primaryButtonCss}
							>
								Approve
							</SiteLink>
						) : (
							<span css={{ color: colors.textMuted }}>
								Approve it from this package's Credentials page.
							</span>
						)
					) : webhook.enabled ? (
						<button
							type="button"
							disabled={isMutating}
							aria-label={
								disableCheck.armed
									? `Confirm disable ${webhookLabel}`
									: `Disable ${webhookLabel}`
							}
							css={secondaryButtonCss}
							onClick={disableCheck.onClick}
							onBlur={disableCheck.onBlur}
						>
							{disableCheck.armed ? 'Confirm disable' : 'Disable'}
						</button>
					) : (
						<button
							type="button"
							disabled={isMutating}
							aria-label={`Enable ${webhookLabel}`}
							css={secondaryButtonCss}
							onClick={() => onIntent({ intent: 'enable' })}
						>
							Enable
						</button>
					)}
					<button
						type="button"
						disabled={isMutating}
						aria-label={
							rotateCheck.armed
								? `Confirm rotate URL for ${webhookLabel}`
								: `Rotate URL for ${webhookLabel}`
						}
						css={dangerButtonCss}
						onClick={rotateCheck.onClick}
						onBlur={rotateCheck.onBlur}
					>
						{rotateCheck.armed ? 'Confirm rotate' : 'Rotate URL'}
					</button>
					<SiteLink href={input.deliveriesHref} css={mutedLinkCss}>
						Recent deliveries
					</SiteLink>
				</div>
			) : null}

			{rotateCheck.armed ? (
				<AccountManagementMessage tone="info">
					Rotating mints a new URL. The previous URL stays active for 24 hours,
					or until a delivery arrives on the new one.
				</AccountManagementMessage>
			) : null}

			{webhook.minted && !webhook.approved ? (
				<AccountManagementMessage tone="info">
					Minting a URL does not turn the webhook on. Deliveries answer 409
					until you approve it.
				</AccountManagementMessage>
			) : null}

			{webhook.minted ? (
				<p css={descriptionCss}>
					Disabling answers 404 without deleting the mint; enabling restores the
					same URL. Removing the declaration from the package manifest retires
					the ingress.{' '}
					<SiteLink href={webhooksDocHref} css={primaryLinkCss}>
						Inbound webhooks docs
					</SiteLink>
				</p>
			) : null}

			{showMintAnother && webhook.minted ? (
				<details
					css={{
						marginTop: spacing.sm,
						paddingTop: spacing.sm,
						borderTop: `1px solid ${colors.border}`,
					}}
					data-testid="package-webhook-mint-another"
				>
					<summary>Mint another URL</summary>
					<form
						css={{
							display: 'grid',
							gap: spacing.sm,
							marginTop: spacing.sm,
						}}
						onSubmit={(event) => {
							event.preventDefault()
							const form = event.currentTarget as HTMLFormElement
							const label = new FormData(form)
								.get('instanceLabel')
								?.toString()
								.trim()
							if (!label) return
							onIntent({
								intent: 'mint',
								createInstance: true,
								instanceLabel: label,
							})
							form.reset()
						}}
					>
						<p css={{ margin: 0, color: colors.textMuted }}>
							Creates another URL under <code>{webhook.name}</code> with its own
							Approve. Give it a short label so you can tell them apart.
						</p>
						<label css={fieldCss}>
							<span css={fieldLabelCss}>Instance label</span>
							<input
								name="instanceLabel"
								type="text"
								required
								maxLength={64}
								placeholder="staging"
								disabled={isMutating}
								css={{
									padding: `${spacing.xs} ${spacing.sm}`,
									border: `1px solid ${colors.border}`,
									borderRadius: '4px',
									fontFamily: 'inherit',
								}}
							/>
						</label>
						<div>
							<button
								type="submit"
								disabled={isMutating}
								aria-label={`Mint another URL for ${webhook.packageKodyId}/${webhook.name}`}
								data-testid="package-webhook-mint-another-submit"
								css={primaryButtonCss}
							>
								Mint another URL
							</button>
						</div>
					</form>
				</details>
			) : null}
		</article>
	)
}

function renderUrlSection(input: {
	webhook: PackageWebhookListItem
	revealedUrl: string | null
	isMutating: boolean
	onIntent: (payload: PackageWebhookCardIntent) => void
	onHideUrl: () => void
}) {
	const { webhook, revealedUrl, isMutating, onIntent, onHideUrl } = input
	if (!webhook.minted) {
		return (
			<div css={{ display: 'grid', gap: spacing.sm }}>
				<p css={{ margin: 0, color: colors.textMuted }}>
					No URL yet. Minting creates the URL and shows it so you can paste it
					into the provider, but the webhook only runs after you approve it.
					Treat the URL as a credential: anyone holding it can POST to this
					export once approved.
				</p>
				<div>
					<button
						type="button"
						disabled={isMutating}
						aria-label={`Mint URL for ${webhook.packageKodyId}/${webhook.name}`}
						data-testid="package-webhook-mint"
						css={primaryButtonCss}
						onClick={() => onIntent({ intent: 'mint' })}
					>
						Mint URL
					</button>
				</div>
			</div>
		)
	}
	if (revealedUrl) {
		return (
			<div css={{ display: 'grid', gap: spacing.sm }}>
				<CopyCard
					label="Webhook URL"
					value={revealedUrl}
					copyLabel="Copy webhook URL"
					variant="pill"
				/>
				<div>
					<button
						type="button"
						aria-label={`Hide URL for ${webhook.packageKodyId}/${webhook.name}`}
						data-testid="package-webhook-hide-url"
						css={secondaryButtonCss}
						onClick={onHideUrl}
					>
						Hide URL
					</button>
				</div>
			</div>
		)
	}
	if (!webhook.urlRecoverable) {
		return (
			<p css={{ margin: 0, color: colors.textMuted }}>
				This URL was minted before Kody kept a recoverable copy of the secret,
				so it cannot be shown here. Rotate it to get a URL you can copy.
			</p>
		)
	}
	return (
		<div css={{ display: 'grid', gap: spacing.sm }}>
			<p css={{ margin: 0, color: colors.textMuted }}>
				Hidden until you reveal it. Only you can see it here; agents connected
				over MCP never receive this URL. Each reveal is recorded in your account
				audit log.
			</p>
			<div>
				<button
					type="button"
					disabled={isMutating}
					aria-label={`Reveal URL for ${webhook.packageKodyId}/${webhook.name}`}
					data-testid="package-webhook-reveal"
					css={secondaryButtonCss}
					onClick={() => onIntent({ intent: 'reveal' })}
				>
					Reveal URL
				</button>
			</div>
		</div>
	)
}
