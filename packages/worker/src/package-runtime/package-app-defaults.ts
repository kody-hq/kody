import { html } from 'remix/html-template'
import { createHtmlResponse } from 'remix/response/html'
import { buildCommunityIconFallbackSvg } from '#worker/community/community-icon-fallback.ts'

/**
 * Marks responses handled by the platform defaults. See
 * {@link applyPackageAppDefaults} for page responses.
 */

export const packageAppDefaultHeader = 'x-kody-default'

export type PackageAppDefaultsInput = {
	request: Request
	response: Response
	/** Package name leaf, used for the title and the generated icon. */
	appName: string
	/** `kody.description`, used for the description tags. */
	description: string | null
	/** Origin-relative app home (`/<leaf>/`, or `/` on a custom hostname). */
	appHomePath: string
}

function isHtmlResponse(response: Response) {
	return (
		response.headers
			.get('Content-Type')
			?.toLowerCase()
			.includes('text/html') === true
	)
}

/** A browser page visit, as opposed to fetch/XHR, assets, or API clients. */
export function isPackageAppPageVisit(request: Request) {
	if (request.method !== 'GET' && request.method !== 'HEAD') return false
	const dest = request.headers.get('Sec-Fetch-Dest')
	if (dest !== null && dest !== 'document') return false
	return (
		request.headers.get('Accept')?.toLowerCase().includes('text/html') === true
	)
}

export function buildPackageAppIconDataUrl(appName: string) {
	return `data:image/svg+xml,${encodeURIComponent(buildCommunityIconFallbackSvg(appName))}`
}

export function buildPackageAppNotFoundPage(input: {
	appName: string
	appHomePath: string
	method: string
}) {
	const response = createHtmlResponse(
		html`<!doctype html>
			<html lang="en">
				<head>
					<meta charset="utf-8" />
					<meta name="viewport" content="width=device-width, initial-scale=1" />
					<meta name="robots" content="noindex" />
					<title>Page not found · ${input.appName}</title>
					<link
						rel="icon"
						href="${buildPackageAppIconDataUrl(input.appName)}"
					/>
					<style>
						:root {
							color-scheme: light dark;
							font-family:
								ui-sans-serif,
								system-ui,
								-apple-system,
								BlinkMacSystemFont,
								'Segoe UI',
								sans-serif;
							line-height: 1.5;
						}
						body {
							margin: 0;
							background: #f8fafc;
							color: #0f172a;
						}
						main {
							box-sizing: border-box;
							display: grid;
							min-height: 100vh;
							place-items: center;
							padding: 1.5rem;
						}
						.card {
							box-sizing: border-box;
							width: 100%;
							max-width: 32rem;
							border: 1px solid #cbd5e1;
							border-radius: 1rem;
							background: white;
							padding: clamp(1.5rem, 5vw, 2.5rem);
							text-align: center;
							box-shadow: 0 20px 60px rgb(15 23 42 / 0.12);
						}
						.code {
							margin: 0;
							font-size: 0.875rem;
							font-weight: 700;
							letter-spacing: 0.08em;
							text-transform: uppercase;
							color: #475569;
						}
						h1 {
							margin: 0.5rem 0 0.75rem;
							font-size: clamp(1.75rem, 5vw, 2.5rem);
							line-height: 1.1;
						}
						p {
							margin: 0 0 1.5rem;
						}
						a {
							display: inline-block;
							border-radius: 999px;
							background: #0f172a;
							color: white;
							padding: 0.65rem 1.25rem;
							font-weight: 600;
							text-decoration: none;
						}
						a:focus-visible {
							outline: 3px solid #38bdf8;
							outline-offset: 3px;
						}
						@media (prefers-color-scheme: dark) {
							body {
								background: #020617;
								color: #e2e8f0;
							}
							.card {
								border-color: #334155;
								background: #0f172a;
							}
							.code {
								color: #94a3b8;
							}
							a {
								background: #e2e8f0;
								color: #0f172a;
							}
						}
					</style>
				</head>
				<body>
					<main>
						<section class="card" aria-labelledby="not-found-title">
							<p class="code">404</p>
							<h1 id="not-found-title">Page not found</h1>
							<p>
								Check the address for typos, or start again from the home page
								of ${input.appName}.
							</p>
							<a href="${input.appHomePath}">Go to the home page</a>
						</section>
					</main>
				</body>
			</html>`,
		{ status: 404 },
	)
	response.headers.set('Cache-Control', 'no-store')
	response.headers.set(packageAppDefaultHeader, 'not-found')
	if (input.method === 'HEAD') {
		return new Response(null, {
			status: 404,
			headers: response.headers,
		})
	}
	return response
}

function escapeAttribute(value: string) {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('"', '&quot;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
}

const namedEntities: Record<string, string> = {
	amp: '&',
	lt: '<',
	gt: '>',
	quot: '"',
	apos: "'",
	nbsp: '\u00a0',
}

/** Page text and attributes arrive as source markup; decode before re-escaping. */
function decodeHtmlEntities(value: string) {
	return value.replace(
		/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi,
		(match, entity: string) => {
			if (entity[0] === '#') {
				const code =
					entity[1]?.toLowerCase() === 'x'
						? Number.parseInt(entity.slice(2), 16)
						: Number.parseInt(entity.slice(1), 10)
				return Number.isFinite(code) && code <= 0x10ffff
					? String.fromCodePoint(code)
					: match
			}
			return namedEntities[entity.toLowerCase()] ?? match
		},
	)
}

function escapeText(value: string) {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
}

/** Add the head tags a document is missing, streaming. */
function injectPackageAppHeadDefaults(
	response: Response,
	input: Pick<PackageAppDefaultsInput, 'appName' | 'description'>,
) {
	const seen = {
		viewport: false,
		description: null as string | null,
		ogTitle: false,
		ogDescription: false,
		icon: false,
	}
	let title = ''
	let titleSeen = false
	let headSeen = false
	const headers = new Headers(response.headers)
	headers.delete('Content-Length')
	headers.set(packageAppDefaultHeader, 'head')
	const rebuilt = new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	})
	return new HTMLRewriter()
		.on('head meta', {
			element(element) {
				const name = element.getAttribute('name')?.trim().toLowerCase()
				const property = element.getAttribute('property')?.trim().toLowerCase()
				if (name === 'viewport') seen.viewport = true
				if (name === 'description') {
					seen.description = element.getAttribute('content') ?? ''
				}
				if (property === 'og:title') seen.ogTitle = true
				if (property === 'og:description') seen.ogDescription = true
			},
		})
		.on('head title', {
			element(element) {
				titleSeen = true
				element.onEndTag((end) => {
					if (!title.trim()) end.before(escapeText(input.appName))
				})
			},
			text(chunk) {
				title += chunk.text
			},
		})
		.on('head link', {
			element(element) {
				const rel = element.getAttribute('rel')?.toLowerCase() ?? ''
				if (rel.split(/\s+/).includes('icon')) seen.icon = true
			},
		})
		.on('head', {
			element(element) {
				if (headSeen) return
				headSeen = true
				element.onEndTag((end) => {
					const tags: Array<string> = []
					if (!seen.viewport) {
						tags.push(
							'<meta name="viewport" content="width=device-width, initial-scale=1" />',
						)
					}
					const pageTitle = decodeHtmlEntities(title).trim() || input.appName
					if (!titleSeen) {
						tags.push(`<title>${escapeText(input.appName)}</title>`)
					}
					const description =
						decodeHtmlEntities(seen.description ?? '').trim() ||
						input.description
					if (seen.description === null && input.description) {
						tags.push(
							`<meta name="description" content="${escapeAttribute(input.description)}" />`,
						)
					}
					if (!seen.ogTitle) {
						tags.push(
							`<meta property="og:title" content="${escapeAttribute(pageTitle)}" />`,
						)
					}
					if (!seen.ogDescription && description) {
						tags.push(
							`<meta property="og:description" content="${escapeAttribute(description)}" />`,
						)
					}
					if (!seen.icon) {
						tags.push(
							`<link rel="icon" href="${escapeAttribute(buildPackageAppIconDataUrl(input.appName))}" />`,
						)
					}
					if (tags.length > 0) end.before(tags.join(''), { html: true })
				})
			},
		})
		.transform(rebuilt)
}

/**
 * Supplies a fallback for non-HTML 404 page visits and fills missing HTML
 * head tags on successful and 404 GET responses.
 */
export async function applyPackageAppDefaults(
	input: PackageAppDefaultsInput,
): Promise<Response> {
	const { request, response } = input
	if (response.webSocket || response.status === 101) return response
	if (
		response.status === 404 &&
		isPackageAppPageVisit(request) &&
		!isHtmlResponse(response)
	) {
		await response.body?.cancel()
		const page = buildPackageAppNotFoundPage({
			appName: input.appName,
			appHomePath: input.appHomePath,
			method: request.method,
		})
		for (const cookie of response.headers.getSetCookie()) {
			page.headers.append('Set-Cookie', cookie)
		}
		return page
	}
	if (
		request.method === 'GET' &&
		response.body &&
		isHtmlResponse(response) &&
		((response.status >= 200 && response.status < 300) ||
			response.status === 404)
	) {
		return injectPackageAppHeadDefaults(response, input)
	}
	return response
}
