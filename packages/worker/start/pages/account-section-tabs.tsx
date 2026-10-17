/** @jsxImportSource @emotion/react */
import { SiteLink } from '../components/site-link.tsx'
import { colors, spacing } from '#universal/styles/tokens.ts'
import { type AccountRailTab } from '#client/routes/account-rail.ts'

/**
 * Sibling pages of one rail item (Activity → Workflows, Waiting), as
 * underline tabs under the page title. Named by the rail item so the label
 * stays the same on every tab.
 */
export function AccountSectionTabs(props: {
	label: string
	tabs: ReadonlyArray<Omit<AccountRailTab, 'id'> & { active: boolean }>
}) {
	return (
		<nav
			aria-label={`${props.label} pages`}
			data-testid="account-section-tabs"
			css={sectionTabsCss}
		>
			{props.tabs.map((tab) => (
				<SiteLink
					key={tab.href}
					href={tab.href}
					aria-current={tab.active ? 'page' : undefined}
					css={sectionTabCss}
				>
					{tab.label}
				</SiteLink>
			))}
		</nav>
	)
}

const sectionTabsCss = {
	display: 'flex',
	flexWrap: 'wrap' as const,
	alignItems: 'center',
	gap: spacing.md,
	borderBottom: `1px solid ${colors.border}`,
}

const sectionTabCss = {
	display: 'inline-flex',
	alignItems: 'center',
	padding: '0.55rem 0.15rem',
	marginBottom: '-1px',
	borderBottom: '2px solid transparent',
	color: colors.textMuted,
	fontSize: '0.95rem',
	fontWeight: 550,
	textDecoration: 'none',
	'&:hover': {
		color: colors.text,
	},
	'&[aria-current="page"]': {
		color: colors.text,
		borderBottomColor: colors.primary,
	},
}
