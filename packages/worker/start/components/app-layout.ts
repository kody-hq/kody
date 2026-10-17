import { type CSSObject } from '@emotion/react'
import { type AppShell } from '../app-shell.ts'
import { mq, spacing, typography } from '#universal/styles/tokens.ts'

export const appFrameCss: CSSObject = {
	width: '100%',
	minHeight: '100vh',
	display: 'flex',
	flexDirection: 'column',
	fontFamily: typography.fontFamily,
	boxSizing: 'border-box',
	overflowX: 'clip',
}

export function appMainCss(
	shell: AppShell,
	illustratedError: boolean,
): CSSObject {
	const auth = shell.mode === 'auth'
	return {
		width: '100%',
		boxSizing: 'border-box',
		flex: 1,
		viewTransitionName: 'page',
		...(auth
			? { display: 'grid' }
			: illustratedError || shell.gutters === 'page'
				? {}
				: mainGutterPaddingCss),
	}
}

export const mainGutterPaddingCss: CSSObject = {
	padding: `${spacing.lg} ${spacing.xl} ${spacing.sm}`,
	[mq.tablet]: { padding: `${spacing.sm} ${spacing.sm} 0` },
	[mq.mobile]: { padding: `${spacing.md} ${spacing.md} ${spacing.sm}` },
}
