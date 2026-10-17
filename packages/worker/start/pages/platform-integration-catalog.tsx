/** @jsxImportSource @emotion/react */
import { type CSSObject } from '@emotion/react'

import { SiteLink } from '../components/site-link.tsx'
import { ProviderMark } from '../components/provider-icons.tsx'
import { type PlatformIntegrationCatalogItem } from '#universal/oauth-connect.ts'
import {
	colors,
	radius,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'

const catalogListCss: CSSObject = {
	listStyle: 'none',
	margin: 0,
	padding: 0,
	display: 'grid',
	gridTemplateColumns: 'repeat(auto-fit, minmax(min(16rem, 100%), 1fr))',
	gap: spacing.sm,
}

const catalogLinkCss: CSSObject = {
	display: 'flex',
	alignItems: 'center',
	gap: spacing.md,
	padding: spacing.md,
	borderRadius: radius.lg,
	border: `1px solid ${colors.border}`,
	backgroundColor: colors.surface,
	color: colors.text,
	textDecoration: 'none',
	'&:hover': { borderColor: colors.primary },
	'&:focus-visible': {
		outline: `2px solid ${colors.primary}`,
		outlineOffset: '2px',
	},
}

/**
 * One-click connect links for discoverable (enabled + published) built-ins.
 * Callers render nothing when `items` is empty — the server only sends
 * published apps, so an all-draft deployment shows no catalog at all.
 */
export function renderPlatformIntegrationCatalog(input: {
	items: ReadonlyArray<PlatformIntegrationCatalogItem>
	testId: string
}) {
	return (
		<ul css={catalogListCss} data-testid={input.testId}>
			{input.items.map((item) => (
				<li key={item.slug} data-testid={`platform-integration-${item.slug}`}>
					<SiteLink href={item.connectHref} css={catalogLinkCss}>
						<ProviderMark
							providerKey={item.provider}
							label={item.label}
							logoPath={item.logoPath}
							catalogLogoPath={item.catalogLogoPath}
							size="2.25rem"
						/>
						<span css={{ display: 'grid', gap: spacing.xs, minWidth: 0 }}>
							<span
								css={{
									fontWeight: typography.fontWeight.semibold,
								}}
							>
								Connect {item.label}
							</span>
							{item.description ? (
								<span
									css={{
										color: colors.textMuted,
										fontSize: typography.fontSize.sm,
									}}
								>
									{item.description}
								</span>
							) : null}
						</span>
					</SiteLink>
				</li>
			))}
		</ul>
	)
}
