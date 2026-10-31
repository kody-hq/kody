/** @jsxImportSource @emotion/react */
import { publicAsset } from '../public-assets.ts'

/**
 * Server-rendered extras that keep a sign-in form usable without the page's
 * app JavaScript (ADR 0094): a note for browsers with JavaScript off, and a
 * small classic script that draws the Turnstile check when the app never
 * hydrates (older engines).
 */
export function AuthFormFallback(props: {
	turnstileSiteKey: string | null
	note: string
}) {
	return (
		<>
			<noscript>
				<p data-testid="auth-no-javascript-note" css={noteCss}>
					{props.note}
				</p>
			</noscript>
			{props.turnstileSiteKey ? (
				<script src={publicAsset('/auth-fallback.js')} async />
			) : null}
		</>
	)
}

const noteCss = {
	margin: 0,
	fontSize: '0.9rem',
	lineHeight: 1.5,
	color: 'var(--color-text-muted)',
	textAlign: 'center' as const,
}
