/** @jsxImportSource @emotion/react */
import { formatTimestampDate } from '../components/local-timestamp.tsx'
import { type AccountPackageDetail } from '#universal/loader-data.ts'
import { getAccentCalloutCss } from '#universal/styles/style-primitives.ts'
import { colors, spacing, typography } from '#universal/styles/tokens.ts'

export function PackageCookieWarningsCallout(props: {
	warnings: NonNullable<AccountPackageDetail['cookieWarnings']>
}) {
	if (props.warnings.length === 0) return null
	return (
		<aside
			data-testid="package-cookie-warnings"
			css={calloutCss}
			aria-labelledby="package-cookie-warnings-heading"
		>
			<h3 id="package-cookie-warnings-heading">Cookies without HttpOnly</h3>
			<p>
				Your app set these cookies without the HttpOnly flag. Scripts on your
				app host can read a cookie without HttpOnly, and that includes other
				apps on the same host.
			</p>
			<ul css={warningsCss}>
				{props.warnings.map((warning) => (
					<li key={`${warning.cookieName}:${warning.reason}`}>
						<div css={cookieDetailsCss}>
							<code>{warning.cookieName}</code>
							<span>Last seen {formatTimestampDate(warning.lastSeenAt)}</span>
						</div>
						<p css={statusCss}>
							{warning.reason === 'added_httponly'
								? 'Kody added HttpOnly because this looks like a sign-in or session cookie. Set it yourself so your app matches what browsers receive. If your page scripts must read it, list it in kody.app.cookies.clientReadable.'
								: 'Not changed. Add HttpOnly unless your page scripts need to read this cookie.'}
						</p>
					</li>
				))}
			</ul>
			<p>To fix it, add HttpOnly to the Set-Cookie header, for example</p>
			<code css={exampleCss}>
				Set-Cookie: name=value; Path=/; HttpOnly; Secure; SameSite=Lax
			</code>
			<p css={footerCss}>
				Kody shows cookie names only, never values. Entries clear after 14 days
				without being seen.
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

const warningsCss = {
	display: 'grid',
	gap: spacing.sm,
	margin: 0,
	padding: 0,
	listStyle: 'none',
}

const cookieDetailsCss = {
	display: 'flex',
	flexWrap: 'wrap',
	alignItems: 'baseline',
	gap: spacing.sm,
	'& span': { color: colors.textMuted },
} as const

const statusCss = {
	marginTop: spacing.xs,
}

const exampleCss = {
	overflowWrap: 'anywhere',
	color: colors.text,
} as const

const footerCss = {
	color: colors.textMuted,
}
