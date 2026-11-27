/** @jsxImportSource @emotion/react */
import { getAccentCalloutCss } from '#universal/styles/style-primitives.ts'
import { Button } from '../components/button.tsx'
import { colors, spacing, typography } from '#universal/styles/tokens.ts'

export function PackageHeldForApprovalCallout(props: {
	held: { servingCommit: string; heldCommit: string } | undefined
	approvalHref: string
}) {
	if (!props.held) return null
	return (
		<aside
			data-testid="package-held-for-approval"
			css={calloutCss}
			aria-labelledby="package-held-for-approval-heading"
		>
			<h3 id="package-held-for-approval-heading">
				Held for approval: your latest publish is not live
			</h3>
			<p>
				Your latest publish (<code>{props.held.heldCommit.slice(0, 7)}</code>)
				asks for more capabilities than the version you approved. Until you
				approve them, everyone, including members of this account, keeps using{' '}
				<code>{props.held.servingCommit.slice(0, 7)}</code>. To try the new
				version first, use local dev or a dev check.
			</p>
			<Button
				href={props.approvalHref}
				data-testid="package-held-for-approval-approve"
				size="sm"
				css={{ justifySelf: 'start' }}
			>
				Approve to update everyone
			</Button>
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
