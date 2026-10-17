/** @jsxImportSource @emotion/react */
import { createFileRoute } from '@tanstack/react-router'
import { loadOrgOverview } from '#start/server/org-management'
import {
	AccountManagementShell,
	AccountPageHeader,
	AccountManagementPanel,
} from '../pages/account-management-components.tsx'
import { workspaceRailGroups } from '#client/routes/account-rail.ts'
import { useShellData } from './__root.tsx'
import { type CSSObject } from '@emotion/react'
import { colors, radius, spacing } from '#universal/styles/tokens.ts'
import { renderIcon } from '../components/icon.tsx'
import { SiteLink } from '../components/site-link.tsx'
export const Route = createFileRoute('/@{$orgSlug}_/-/overview')({
	staticData: {
		navigation: { rail: 'workspace', item: 'overview' },
		orgScope: {},
	},
	loader: ({ params }) => loadOrgOverview({ data: { slug: params.orgSlug } }),
	component: Page,
	head: () => ({ meta: [{ title: 'Overview' }] }),
})
function Page() {
	const { slug } = Route.useLoaderData()
	const session = useShellData().session
	const org = session?.organizations?.find((entry) => entry.slug === slug)
	const personal = org?.personal ?? slug === session?.username
	const role =
		org !== undefined
			? org.role
			: personal
				? ('owner' as const)
				: ('member' as const)
	return (
		<AccountManagementShell currentHref={`/@${slug}/-/overview`}>
			<AccountPageHeader
				title="Overview"
				description={`Everything @${slug} holds: repositories, agents, credentials, jobs, and the rest.`}
				currentHref={`/@${slug}/-/overview`}
			/>
			{workspaceRailGroups({ orgSlug: slug, personal, role })
				.filter((group) => group.label !== null)
				.map((group) => (
					<AccountManagementPanel key={group.label} title={group.label ?? ''}>
						{group.note ? (
							<p css={groupNoteCss} data-testid="org-overview-group-note">
								{group.note}
							</p>
						) : null}
						<ul
							css={cardGridCss}
							aria-label={group.label ?? undefined}
							data-testid={`org-overview-${group.label?.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`}
						>
							{group.items.map((item) => (
								<li key={item.href}>
									<SiteLink href={item.href} css={cardCss}>
										<span aria-hidden="true" css={cardIconCss}>
											{renderIcon(item.icon, { size: '1.15rem' })}
										</span>
										<span css={cardCopyCss}>
											<span css={cardTitleCss}>{item.label}</span>
											{item.description ? (
												<span css={cardBodyCss}>{item.description}</span>
											) : null}
										</span>
									</SiteLink>
								</li>
							))}
						</ul>
					</AccountManagementPanel>
				))}
		</AccountManagementShell>
	)
}

const groupNoteCss: CSSObject = {
	margin: `0 0 ${spacing.sm}`,
	fontSize: '0.9rem',
	lineHeight: 1.45,
	color: colors.textMuted,
}

const cardGridCss: CSSObject = {
	listStyle: 'none',
	margin: 0,
	padding: 0,
	display: 'grid',
	gridTemplateColumns: 'repeat(auto-fill, minmax(15rem, 1fr))',
	gap: spacing.sm,
}

const cardCss: CSSObject = {
	display: 'flex',
	alignItems: 'flex-start',
	gap: spacing.md,
	height: '100%',
	boxSizing: 'border-box' as const,
	padding: spacing.md,
	borderRadius: radius.card,
	border: `1.5px solid ${colors.border}`,
	backgroundColor: colors.surface,
	color: colors.text,
	textDecoration: 'none',
	'&:hover': {
		borderColor: colors.primary,
	},
}

const cardIconCss: CSSObject = {
	display: 'inline-flex',
	alignItems: 'center',
	justifyContent: 'center',
	flexShrink: 0,
	width: '2.25rem',
	height: '2.25rem',
	borderRadius: radius.full,
	backgroundColor: colors.primarySoftest,
	color: colors.primaryText,
}

const cardCopyCss: CSSObject = {
	display: 'grid',
	gap: spacing.xs,
	minWidth: 0,
}

const cardTitleCss: CSSObject = {
	fontSize: '1rem',
	fontWeight: 650,
}

const cardBodyCss: CSSObject = {
	fontSize: '0.9rem',
	color: colors.textMuted,
	lineHeight: 1.45,
}
