/** @jsxImportSource @emotion/react */
import { capabilityAllowanceExample } from '#worker/package-runtime/package-app-capability-allowances.ts'
import { getAccentCalloutCss } from '#universal/styles/style-primitives.ts'
import { colors, spacing, typography } from '#universal/styles/tokens.ts'

export function PackageCapabilityAllowanceCallout(props: {
	capabilities: ReadonlyArray<string>
}) {
	if (props.capabilities.length === 0) return null
	return (
		<aside
			data-testid="package-capability-allowance"
			css={calloutCss}
			aria-labelledby="package-capability-allowance-heading"
		>
			<h3 id="package-capability-allowance-heading">
				Declare these capabilities before your next publish
			</h3>
			<p>
				Your published version calls these Kody capabilities without listing
				them in <code>kody.app.capabilities</code>. Kody lets this published
				version keep calling them, so nothing changes for your visitors today.
				The allowance does not carry over: once you publish a new version
				without them, these calls fail.
			</p>
			<ul css={listCss}>
				{props.capabilities.map((name) => (
					<li key={name}>
						<code>{name}</code>
					</li>
				))}
			</ul>
			<p>Add them to package.json, for example</p>
			<code css={exampleCss}>
				{capabilityAllowanceExample(props.capabilities)}
			</code>
			<p css={footerCss}>
				Publish and <code>kody dev check</code> list the same names.
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

const listCss = {
	display: 'grid',
	gap: spacing.xs,
	margin: 0,
	paddingLeft: spacing.lg,
}

const exampleCss = {
	overflowWrap: 'anywhere',
	color: colors.text,
} as const

const footerCss = {
	color: colors.textMuted,
}
