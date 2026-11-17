/** @jsxImportSource @emotion/react */
import type { CSSObject } from '@emotion/react'
import type { CSSProperties, ReactNode } from 'react'
import { accountDeviceSignInPath } from '#universal/oauth-paths.ts'
import { packageAppOauthPaths } from '#universal/package-app-oauth-paths.ts'
import { colors } from '#universal/styles/tokens.ts'
import { textLinkCss } from './text-link.tsx'

/**
 * "Sign in with another device" (ADR 0094): a plain form that works with no
 * page JavaScript. `target` is the sign-in page's package-app `redirectTo`
 * (see `packageAppDeviceSignInTarget`).
 */
export function DeviceSignInOption(props: { target: string; rise?: number }) {
	return (
		<DeviceSignInLinkForm
			action={packageAppOauthPaths.device}
			rise={props.rise}
			testId="sign-in-on-another-device"
		>
			<input type="hidden" name="authorize" value={props.target} />
		</DeviceSignInLinkForm>
	)
}

/**
 * "Sign in with another device" for Kody's own sign-in (ADR 0094): approve
 * this browser from a device already signed in to Kody. `redirectTo` is where
 * the browser lands once approved. "Keep this browser signed in" lives on the
 * code screen.
 */
export function AccountDeviceSignInOption(props: {
	redirectTo: string | null
	rise?: number
}) {
	return (
		<DeviceSignInLinkForm
			action={accountDeviceSignInPath}
			rise={props.rise}
			testId="account-sign-in-on-another-device"
		>
			{props.redirectTo ? (
				<input type="hidden" name="redirectTo" value={props.redirectTo} />
			) : null}
		</DeviceSignInLinkForm>
	)
}

/** A quiet one-line form whose submit button reads as a text link. */
function DeviceSignInLinkForm(props: {
	action: string
	rise?: number
	testId: string
	children: ReactNode
}) {
	return (
		<form
			method="post"
			action={props.action}
			data-rise={props.rise === undefined ? undefined : ''}
			style={
				props.rise === undefined
					? undefined
					: ({ '--rise': String(props.rise) } as CSSProperties)
			}
			css={deviceSignInCss}
			data-testid={props.testId}
		>
			{props.children}
			<p>
				Using an e-reader or older browser?{' '}
				<button type="submit" css={[linkButtonResetCss, textLinkCss()]}>
					Sign in with another device
				</button>
				.
			</p>
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
				? 'The human check cannot run in this browser. Use Sign in with another device instead.'
				: 'The human check cannot run in this browser. Try a newer browser.'}
		</p>
	)
}

const deviceSignInCss: CSSObject = {
	margin: 0,
	'& p': {
		margin: 0,
		fontSize: '0.88rem',
		lineHeight: 1.5,
		color: colors.textMuted,
		textAlign: 'center',
	},
}

const linkButtonResetCss: CSSObject = {
	display: 'inline',
	padding: 0,
	border: 0,
	background: 'none',
	font: 'inherit',
	cursor: 'pointer',
}

const helpCss: CSSObject = {
	margin: 0,
	fontSize: '0.9rem',
	lineHeight: 1.5,
	color: colors.error,
	textAlign: 'center',
}
