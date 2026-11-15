/** @jsxImportSource @emotion/react */
import {
	getAccentCalloutCss,
	getPillButtonCss,
} from '#universal/styles/style-primitives.ts'
import { colors, spacing, typography } from '#universal/styles/tokens.ts'
import { SiteLink } from '../components/site-link.tsx'

export function PackagePublicVisitorsHeldBackCallout(props: {
	heldBack: { publicCommit: string; servingCommit: string } | undefined
	approvalHref: string
}) {
	if (!props.heldBack) return null
	return (
		<aside
			data-testid="package-public-visitors-held-back"
			css={calloutCss}
			aria-labelledby="package-public-visitors-held-back-heading"
		>
			<h3 id="package-public-visitors-held-back-heading">
				Public visitors are still on the previous version
			</h3>
			<p>
				Your latest publish (
				<code>{props.heldBack.servingCommit.slice(0, 7)}</code>) asks for more
				capabilities than the version you approved for public visitors, so they
				keep using <code>{props.heldBack.publicCommit.slice(0, 7)}</code>.
				Members of this account already see the latest publish. Approve the new
				capabilities to update public visitors.
			</p>
			<SiteLink
				href={props.approvalHref}
				data-testid="package-public-visitors-held-back-approve"
				css={approveLinkCss}
			>
				Approve to update public visitors
			</SiteLink>
		</aside>
	)
}

const calloutCss = {
	...getAccentCalloutCss(),
	margin: 0,
	display: 'grid',
	gap: spacing.sm,
	maxWidth: '62ch',
	'& h3': {
		margin: 0,
		fontSize: typography.fontSize.base,
		fontWeight: typography.fontWeight.semibold,
		color: colors.text,
	},
	'& p': {
		margin: 0,
		color: colors.text,
	},
}

const approveLinkCss = {
	...getPillButtonCss({ size: 'sm' }),
	display: 'inline-flex',
	justifySelf: 'start',
	textDecoration: 'none',
}
