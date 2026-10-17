/** @jsxImportSource @emotion/react */
import { SiteLink } from '../components/site-link.tsx'
import {
	AccountManagementShell,
	AccountPageHeader,
} from './account-management-components.tsx'
import { RecordTable, recordCellClamp } from './record-table.tsx'
import {
	buildPackageWebhooksHref,
	webhookDeclaredCount,
	webhookModeLabel,
	webhookStatusColor,
	webhookStatusLabel,
	webhookVerificationLabel,
	webhooksDocHref,
} from '#client/routes/webhooks-shared.ts'
import { type AccountWebhooksLoaderData } from '#universal/loader-data.ts'
import { primaryLinkCss } from '#universal/styles/style-primitives.ts'
import { colors, spacing } from '#universal/styles/tokens.ts'

const clampedCellCss = recordCellClamp(28)

/**
 * `/account/webhooks` — a thin cross-package index. Each row deep-links into
 * the owning package's settings, where the owner mints, reveals, copies,
 * rotates, and disables the URL. Nothing here carries or mutates a credential.
 */
export function AccountWebhooksPage({
	payload,
	currentHref,
}: {
	payload: AccountWebhooksLoaderData
	currentHref: string
}) {
	const { username, webhooks } = payload

	const mintedCount = webhooks.filter((webhook) => webhook.minted).length

	return (
		<AccountManagementShell currentHref={currentHref} busy={false}>
			<AccountPageHeader
				entity="webhooks"
				title="Webhooks"
				description="Every inbound webhook your packages declare, in one list. Webhooks belong to the package that declares them, so open a row to mint, reveal, copy, rotate, or disable its URL in that package's settings."
				currentHref={currentHref}
			/>

			{
				<RecordTable
					mode="none"
					ariaLabel="Webhooks"
					countLabel={`${webhookDeclaredCount(webhooks)} declared · ${mintedCount} minted`}
					emptyLabel="No package on this account declares a webhook yet. Add a kody.webhooks entry to a package manifest and publish it."
					columns={[
						{ key: 'name', label: 'Webhook', primary: true },
						{ key: 'package', label: 'Package' },
						{ key: 'status', label: 'Status' },
						{ key: 'mode', label: 'Mode', drop: 2 },
						{ key: 'verification', label: 'Verification', drop: 1 },
					]}
					rows={webhooks.map((webhook) => ({
						id: webhook.id,
						href: buildPackageWebhooksHref({
							username,
							kodyId: webhook.packageKodyId,
							webhookName: webhook.name,
							endpointId: webhook.endpointId,
						}),
						cells: {
							name: <span css={clampedCellCss}>{webhook.name}</span>,
							package: <span css={clampedCellCss}>{webhook.packageName}</span>,
							status: (
								<span css={{ color: webhookStatusColor(webhook) }}>
									{webhookStatusLabel(webhook)}
								</span>
							),
							mode: (
								<span css={clampedCellCss}>{webhookModeLabel(webhook)}</span>
							),
							verification: (
								<span css={clampedCellCss}>
									{webhookVerificationLabel(webhook)}
								</span>
							),
						},
					}))}
				/>
			}

			{
				<p css={{ color: colors.textMuted, margin: `${spacing.md} 0 0` }}>
					Webhooks are declared in <code>package.json#kody.webhooks</code>; each
					name binds one export and its URL is managed from the owning package's
					settings.{' '}
					<SiteLink href={webhooksDocHref} css={primaryLinkCss}>
						Inbound webhooks docs
					</SiteLink>
				</p>
			}
		</AccountManagementShell>
	)
}
