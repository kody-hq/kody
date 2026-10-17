/** @jsxImportSource @emotion/react */
import { publicAsset } from '../public-assets.ts'
import { ErrorAgentPromptButton } from './error-agent-prompt-button.tsx'
import { buildInternalErrorAgentPrompt } from '#universal/error-agent-prompt-presets.ts'
import { SiteLink } from './site-link.tsx'
import { routes } from '#universal/routes.ts'
import {
	internalErrorPageCopy,
	internalErrorPageHeading,
	internalErrorPageImageAlt,
	internalErrorPageImageSrc,
} from '#universal/internal-error-page.ts'
import { normalizeRedirectTo } from '#universal/safe-redirect.ts'
import {
	getGhostButtonCss,
	getPillButtonCss,
} from '#universal/styles/style-primitives.ts'
import {
	illustratedErrorActionsCss,
	illustratedErrorCopyCss,
	illustratedErrorHeadingCss,
	illustratedErrorPageCss,
	illustratedErrorTallImageCss,
} from '#client/illustrated-error-page.ts'
import { useLocation } from '@tanstack/react-router'

/**
 * Shared HTML 500. Uncaught handler failures try to render this inside the
 * app shell (same treatment as the illustrated 404). A static document with
 * the same copy and art is the fallback when even the shell cannot render.
 */
export function InternalErrorPage() {
	const retryHref =
		normalizeRedirectTo(useLocation({ select: (location) => location.href })) ??
		'/'

	return (
		<section data-testid="internal-error-page" css={illustratedErrorPageCss}>
			<img
				src={publicAsset(internalErrorPageImageSrc)}
				alt={internalErrorPageImageAlt}
				width={1024}
				height={1536}
				css={illustratedErrorTallImageCss}
			/>
			<h1 css={illustratedErrorHeadingCss}>{internalErrorPageHeading}</h1>
			<p css={illustratedErrorCopyCss}>{internalErrorPageCopy}</p>
			<nav aria-label="What to try next" css={illustratedErrorActionsCss}>
				<a href={retryHref} css={getPillButtonCss()}>
					Try again
				</a>
				<SiteLink href={routes.home.href()} css={getGhostButtonCss()}>
					Go home
				</SiteLink>
			</nav>
			<ErrorAgentPromptButton
				prompt={buildInternalErrorAgentPrompt({ path: retryHref })}
			/>
		</section>
	)
}
