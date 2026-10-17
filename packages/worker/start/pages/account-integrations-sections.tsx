/** @jsxImportSource @emotion/react */
import { relocateAccountHref } from '#universal/org-pages.ts'
import { type AccountIntegrationsLoaderData } from '#universal/loader-data.ts'
import { type PlatformIntegrationCatalogItem } from '#universal/oauth-connect.ts'
import { routes } from '#universal/routes.ts'
import { docHref } from '#universal/docs-nav.ts'
import { type CSSObject } from '@emotion/react'
import { SiteLink } from '../components/site-link.tsx'
import { CopyTextButton } from '../components/copy-text-button.tsx'
import { ProviderIcon } from '../components/provider-icons.tsx'
import { renderIcon } from '../components/icon.tsx'
import { renderByokExplainer } from './byok-explainer.tsx'
import { renderPlatformIntegrationCatalog } from './platform-integration-catalog.tsx'
import { recordBodyCss } from './record-table.tsx'
import {
	buildCustomIntegrationSetupPrompt,
	buildIntegrationSetupPrompt,
	integrationProviderSuggestions,
} from '#client/routes/integration-provider-catalog.ts'
import {
	colors,
	radius,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'
import {
	cardCss,
	cardTitleCss,
	descriptionCss,
	getPillButtonCss,
	primaryLinkCss,
	sectionTitleCss,
} from '#universal/styles/style-primitives.ts'
import { advancedDetailsCss } from './account-integrations-detail.tsx'

const providerCatalogGridCss: CSSObject = {
	display: 'grid',
	gridTemplateColumns: 'repeat(auto-fit, minmax(min(22rem, 100%), 1fr))',
	gap: spacing.lg,
}

function PlugIcon() {
	return renderIcon('plug', { size: '1.25em' })
}

export function renderApprovalCard(props: {
	currentHref: string
	approval: NonNullable<AccountIntegrationsLoaderData['approval']>
	submitting: boolean
	onApprove: () => void
}) {
	const { approval, submitting, onApprove } = props
	return (
		<section
			data-testid="integration-approval-card"
			css={{
				display: 'grid',
				gap: spacing.md,
				padding: spacing.lg,
				borderRadius: radius.lg,
				border: `1px solid ${colors.primary}`,
				backgroundColor: colors.primarySoftest,
				marginBlockEnd: spacing.lg,
			}}
		>
			<div css={{ display: 'grid', gap: spacing.xs }}>
				<h2
					css={{
						margin: 0,
						fontSize: typography.fontSize.lg,
						fontWeight: typography.fontWeight.semibold,
						color: colors.text,
					}}
				>
					Approve integration access
				</h2>
				<p css={{ margin: 0, color: colors.textMuted }}>
					{approval.alreadyGranted ? (
						<>
							Package{' '}
							<strong css={{ color: colors.text }}>
								{approval.packageKodyId ?? approval.packageId}
							</strong>{' '}
							can already use integration <code>{approval.name}</code>
							{approval.usageMode === 'any' ? ' from any context.' : '.'}
						</>
					) : (
						<>
							Allow package{' '}
							<strong css={{ color: colors.text }}>
								{approval.packageKodyId ?? approval.packageId}
							</strong>{' '}
							to use integration <code>{approval.name}</code>.
						</>
					)}
				</p>
			</div>
			<div
				css={{
					display: 'flex',
					flexWrap: 'wrap',
					gap: spacing.xs,
				}}
			>
				{approval.alreadyGranted ? (
					<SiteLink
						href={relocateAccountHref(
							'/account/integrations',
							props.currentHref,
						)}
						css={{
							...getPillButtonCss({ size: 'sm' }),
							display: 'inline-flex',
							textDecoration: 'none',
						}}
					>
						Back to integrations
					</SiteLink>
				) : (
					<>
						<button
							type="button"
							data-testid="approve-integration-package"
							disabled={submitting}
							onClick={onApprove}
							css={getPillButtonCss({ size: 'sm' })}
						>
							{submitting ? 'Approving…' : 'Approve'}
						</button>
						<SiteLink
							href={relocateAccountHref(
								'/account/integrations',
								props.currentHref,
							)}
							css={{
								...getPillButtonCss({ size: 'sm' }),
								display: 'inline-flex',
								textDecoration: 'none',
							}}
						>
							Cancel
						</SiteLink>
					</>
				)}
			</div>
		</section>
	)
}

export function renderRecordNotFound(kind: 'connection' | 'integration') {
	return (
		<div
			css={{ ...recordBodyCss, gap: spacing.sm }}
			data-testid={`${kind}-not-found`}
		>
			<h2
				css={{
					margin: 0,
					fontSize: typography.fontSize.lg,
					fontWeight: typography.fontWeight.semibold,
					color: colors.text,
				}}
			>
				{kind === 'connection'
					? 'Connection not found'
					: 'Integration not found'}
			</h2>
			<p css={{ margin: 0, color: colors.textMuted }}>
				{kind === 'connection'
					? 'This connection does not exist for this account or is unavailable.'
					: 'This integration does not exist for this account or is unavailable.'}
			</p>
		</div>
	)
}

export function renderIntegrationsSetupSections(
	setupIntro: string,
	platformCatalog: ReadonlyArray<PlatformIntegrationCatalogItem>,
) {
	return (
		<>
			{platformCatalog.length > 0 ? (
				<section css={{ display: 'grid', gap: spacing.lg }}>
					<div css={{ display: 'grid', gap: spacing.xs }}>
						<h2 css={sectionTitleCss}>Connect with Kody</h2>
						<p css={descriptionCss}>
							These use Kody's built-in OAuth apps, so there is nothing to set
							up first.
						</p>
					</div>
					{renderPlatformIntegrationCatalog({
						items: platformCatalog,
						testId: 'integrations-platform-catalog',
					})}
				</section>
			) : null}

			<details
				css={advancedDetailsCss}
				data-testid="integrations-how-connections-work"
			>
				<summary>How connections work</summary>
				{renderByokExplainer({ image: 'keys' })}
			</details>

			<section css={{ display: 'grid', gap: spacing.lg }}>
				<div css={{ display: 'grid', gap: spacing.xs }}>
					<h2 css={sectionTitleCss}>Set up with your agent</h2>
					<p css={descriptionCss}>{setupIntro}</p>
				</div>

				<div css={providerCatalogGridCss}>
					{integrationProviderSuggestions.map((provider) => (
						<article key={provider.id} css={cardCss}>
							<div css={{ display: 'grid', gap: spacing.md }}>
								<div css={{ display: 'grid', gap: spacing.xs }}>
									<h3
										css={{
											...cardTitleCss,
											display: 'flex',
											alignItems: 'center',
											gap: spacing.sm,
										}}
									>
										<ProviderIcon providerId={provider.id} />
										{provider.name}
									</h3>
									<p css={descriptionCss}>{provider.tagline}</p>
									{provider.guideSlug ? (
										<p
											css={{
												margin: 0,
												fontSize: typography.fontSize.sm,
											}}
										>
											<SiteLink
												href={docHref(provider.guideSlug)}
												css={primaryLinkCss}
											>
												Setup guide
											</SiteLink>
										</p>
									) : null}
								</div>
								<div>
									<CopyTextButton
										value={buildIntegrationSetupPrompt(provider)}
										idleLabel="Copy setup prompt"
										variant="ghost"
										size="sm"
									/>
								</div>
							</div>
						</article>
					))}

					<article css={cardCss}>
						<div css={{ display: 'grid', gap: spacing.md }}>
							<div css={{ display: 'grid', gap: spacing.xs }}>
								<h3
									css={{
										...cardTitleCss,
										display: 'flex',
										alignItems: 'center',
										gap: spacing.sm,
									}}
								>
									{PlugIcon()}
									Something else
								</h3>
								<p css={descriptionCss}>
									If it has an API, your Kody can learn to use it.
								</p>
							</div>
							<div>
								<CopyTextButton
									value={buildCustomIntegrationSetupPrompt()}
									idleLabel="Copy setup prompt"
									variant="ghost"
									size="sm"
								/>
							</div>
						</div>
					</article>
				</div>
			</section>
		</>
	)
}
