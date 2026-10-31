/** @jsxImportSource @emotion/react */
import { getAccentCalloutCss } from '#universal/styles/style-primitives.ts'
import { colors, spacing, typography } from '#universal/styles/tokens.ts'

export function PackageUnmappableCredentialsCallout(props: {
	notice: string | undefined
	collaboratorsHref: string
}) {
	if (!props.notice) return null
	return (
		<aside
			data-testid="package-unmappable-credentials-notice"
			css={calloutCss}
			aria-labelledby="package-unmappable-credentials-heading"
		>
			<h3 id="package-unmappable-credentials-heading">
				Changes are owner-only
			</h3>
			<p>{props.notice}</p>
			<p>
				<a href={props.collaboratorsHref}>Open Collaborators</a> to allow a
				specific person or team.
			</p>
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
