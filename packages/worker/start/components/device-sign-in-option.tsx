/** @jsxImportSource @emotion/react */
import { type CSSObject } from '@emotion/react'
import { type CSSProperties } from 'react'
import { packageAppOauthPaths } from '#universal/package-app-oauth-paths.ts'
import { getGhostButtonCss } from '#universal/styles/style-primitives.ts'
import { colors } from '#universal/styles/tokens.ts'

/**
 * "Sign in on another device" (ADR 0094): a plain form that works with no
 * page JavaScript. `target` is the sign-in page's package-app `redirectTo`
 * (see `packageAppDeviceSignInTarget`).
 */
export function DeviceSignInOption(props: { target: string; rise?: number }) {
	return (
		<form
			method="post"
			action={packageAppOauthPaths.device}
			data-rise={props.rise === undefined ? undefined : ''}
			style={
				props.rise === undefined
					? undefined
					: ({ '--rise': String(props.rise) } as CSSProperties)
			}
			css={deviceSignInCss}
			data-testid="sign-in-on-another-device"
		>
			<input type="hidden" name="authorize" value={props.target} />
			<p>
				<strong>On an e-reader or an older browser?</strong> Approve this
				sign-in from your phone or computer instead. You get a short code and a
				QR code.
			</p>
			<button type="submit" css={deviceSignInButtonCss}>
				Sign in on another device
			</button>
		</form>
	)
}

/**
 * Shown by `public/auth-fallback.js` when the Turnstile check reports an
 * error or an unsupported browser, so the visitor is not left guessing.
 */
export function HumanCheckHelp(props: { deviceSignIn: boolean }) {
	return (
		<p hidden data-human-check-help="" role="status" css={helpCss}>
			{props.deviceSignIn
				? 'The human check cannot run in this browser. Use Sign in on another device instead.'
				: 'The human check cannot run in this browser. Try a newer browser.'}
		</p>
	)
}

const deviceSignInCss: CSSObject = {
	display: 'grid',
	gap: '0.7rem',
	padding: '1rem',
	borderRadius: '0.9rem',
	border: `1px solid ${colors.border}`,
	'& p': {
		margin: 0,
		fontSize: '0.92rem',
		lineHeight: 1.5,
		color: colors.textMuted,
	},
	'& strong': { color: colors.text },
}

const deviceSignInButtonCss: CSSObject = {
	...getGhostButtonCss(),
	justifySelf: 'start',
}

const helpCss: CSSObject = {
	margin: 0,
	fontSize: '0.9rem',
	lineHeight: 1.5,
	color: colors.error,
	textAlign: 'center',
}
