/** @jsxImportSource @emotion/react */
import { SiteLink } from '../components/site-link.tsx'
import {
	underlineLinkTabCss,
	underlineLinkTabsCss,
} from '#universal/styles/style-primitives.ts'
import type { AccountRailTab } from '#client/routes/account-rail.ts'

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
			css={underlineLinkTabsCss}
		>
			{props.tabs.map((tab) => (
				<SiteLink
					key={tab.href}
					href={tab.href}
					aria-current={tab.active ? 'page' : undefined}
					css={underlineLinkTabCss}
				>
					{tab.label}
				</SiteLink>
			))}
		</nav>
	)
}
