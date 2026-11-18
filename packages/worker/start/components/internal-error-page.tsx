/** @jsxImportSource @emotion/react */
import { publicAsset } from '../public-assets.ts'
import { ErrorAgentPromptButton } from './error-agent-prompt-button.tsx'
import { buildInternalErrorAgentPrompt } from '#universal/error-agent-prompt-presets.ts'
import { routes } from '#universal/routes.ts'
import {
	internalErrorPageCopy,
	internalErrorPageHeading,
	internalErrorPageImageAlt,
	internalErrorPageImageSrc,
	internalErrorSupportHref,
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
 * Route errors can render inside the app shell. The HTTP boundary has a
 * static version for failures that happen outside the route boundary.
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
				<a href={routes.home.href()} css={getGhostButtonCss({ size: 'sm' })}>
					Go home
				</a>
				<a
					href={internalErrorSupportHref}
					css={getGhostButtonCss({ size: 'sm' })}
				>
					Contact support
				</a>
			</nav>
			<ErrorAgentPromptButton
				prompt={buildInternalErrorAgentPrompt({ path: retryHref })}
			/>
		</section>
	)
}
