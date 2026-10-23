import { html } from 'remix/html-template'
import { render } from '#app/render.ts'
import { DEFAULT_DOCUMENT_TITLE } from '#universal/document-head.ts'
import { renderErrorAgentPromptStaticHtml } from '#universal/error-agent-prompt.ts'
import { buildInternalErrorAgentPrompt } from '#universal/error-agent-prompt-presets.ts'
import { routes } from '#universal/routes.ts'
import {
	internalErrorPageCopy,
	internalErrorPageHeading,
	internalErrorPageImageAlt,
	internalErrorPageImageSrc,
} from '#universal/internal-error-page.ts'
import { normalizeRedirectTo } from '#universal/safe-redirect.ts'
import {
	layoutMaxWidths,
	pageGutter,
} from '#universal/styles/style-primitives.ts'

/**
 * Minimal first-party HTML for uncaught handler failures. The catch that
 * calls this may have come from rendering the app shell, so this document
 * is static: no client entry, no inline scripts.
 */
export function renderInternalServerErrorPage(retryHref = '/') {
	return render(
		html`<!doctype html>
			<html lang="en">
				<head>
					<meta charset="utf-8" />
					<meta name="viewport" content="width=device-width, initial-scale=1" />
					<link rel="icon" href="/favicon.ico" sizes="32x32" />
					<link rel="icon" type="image/svg+xml" href="/favicon.svg" />
					<title>Something went wrong — ${DEFAULT_DOCUMENT_TITLE}</title>
					<link rel="stylesheet" href="/styles.css" />
					<style>
						.illustrated-error-page {
							box-sizing: border-box;
							width: 100%;
							max-width: ${layoutMaxWidths.narrow};
							margin-inline: auto;
							padding: clamp(2rem, 6vw, 4rem) ${pageGutter}
								clamp(3rem, 8vw, 5rem);
							display: grid;
							justify-items: center;
							text-align: center;
							gap: 1rem;
						}
						.illustrated-error-page img {
							width: min(16rem, 64vw);
							max-height: min(24rem, 52vh);
							height: auto;
							object-fit: contain;
							display: block;
						}
						.illustrated-error-page h1 {
							margin: 0.4rem 0 0;
							font: 700 clamp(1.6rem, 4vw, 2.1rem) / 1.15 var(--font-display);
							letter-spacing: -0.02em;
							color: var(--color-text);
							text-wrap: balance;
						}
						.illustrated-error-page p {
							margin: 0;
							max-width: 36rem;
							color: var(--color-text-muted);
							font-size: 1.02rem;
							line-height: 1.5;
							text-wrap: pretty;
						}
						.illustrated-error-page nav {
							display: flex;
							flex-wrap: wrap;
							justify-content: center;
							gap: 0.7rem;
							margin-top: 0.6rem;
						}
						.illustrated-error-page a {
							display: inline-flex;
							align-items: center;
							justify-content: center;
							font: 650 1rem / 1 var(--font-display);
							border-radius: 999px;
							padding: 0.95rem 1.7rem;
							text-decoration: none;
							white-space: nowrap;
						}
						.illustrated-error-page a[data-variant='pill'] {
							background: var(--color-primary);
							color: var(--color-on-primary);
						}
						.illustrated-error-page a[data-variant='ghost'] {
							background: transparent;
							color: var(--color-text);
							box-shadow: inset 0 0 0 1.5px var(--color-border);
						}
					</style>
				</head>
				<body>
					<main>
						<section
							data-testid="internal-error-page"
							class="illustrated-error-page"
						>
							<img
								src="${internalErrorPageImageSrc}"
								alt="${internalErrorPageImageAlt}"
								width="1024"
								height="1536"
							/>
							<h1>${internalErrorPageHeading}</h1>
							<p>${internalErrorPageCopy}</p>
							<nav aria-label="What to try next">
								<a data-variant="pill" href="${retryHref}">Try again</a>
								<a data-variant="ghost" href="${routes.home.href()}">Go home</a>
							</nav>
							${html.raw`${renderErrorAgentPromptStaticHtml(buildInternalErrorAgentPrompt({ path: retryHref }))}`}
						</section>
					</main>
				</body>
			</html>`,
		{ status: 500, headers: { 'Cache-Control': 'no-store' } },
	)
}

export function retryHrefFromRequest(request: Request) {
	const url = new URL(request.url)
	return normalizeRedirectTo(`${url.pathname}${url.search}`) ?? '/'
}
