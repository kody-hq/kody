/** @jsxImportSource @emotion/react */
import { Button } from './button.tsx'
import { publicAsset } from '../public-assets.ts'
import { ErrorAgentPromptButton } from './error-agent-prompt-button.tsx'
import { buildNotFoundErrorAgentPrompt } from '#universal/error-agent-prompt-presets.ts'
import { useLocation } from '@tanstack/react-router'
import { routes } from '#universal/routes.ts'
import {
	illustratedErrorActionsCss,
	illustratedErrorCopyCss,
	illustratedErrorHeadingCss,
	illustratedErrorImageCss,
	illustratedErrorPageCss,
} from '#client/illustrated-error-page.ts'

const notFoundPageHeading = "This doesn't quite connect."
const notFoundPageImageSrc = '/images/kody-404-disappointed.png'

/**
 * Shared HTML 404. Generic misses and matched-route misses (a public
 * package URL that does not exist) used to pad and title themselves
 * differently; both now render this page.
 */
export function NotFoundPage() {
	const path = useLocation({ select: (location) => location.pathname })
	return (
		<section data-testid="not-found-page" css={illustratedErrorPageCss}>
			<img
				src={publicAsset(notFoundPageImageSrc)}
				alt="Kody looking disappointed, holding an Ethernet plug and a USB-C cable that do not match"
				width={1254}
				height={1254}
				css={illustratedErrorImageCss}
			/>
			<h1 css={illustratedErrorHeadingCss}>{notFoundPageHeading}</h1>
			<p css={illustratedErrorCopyCss}>
				That address isn't a page we have. It may have moved, never existed, or
				the package was unpublished.
			</p>
			<nav aria-label="What to try next" css={illustratedErrorActionsCss}>
				<Button href={routes.home.href()} variant="primary" size="lg">
					Go home
				</Button>
				<Button
					href={routes.docs.href()}
					variant="secondary"
				>
					Search the docs
				</Button>
				<Button
					href={routes.community.href()}
					variant="secondary"
				>
					Browse packages
				</Button>
			</nav>
			<ErrorAgentPromptButton
				prompt={buildNotFoundErrorAgentPrompt({ path: path })}
			/>
		</section>
	)
}
