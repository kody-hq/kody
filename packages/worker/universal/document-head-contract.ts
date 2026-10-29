export const DEFAULT_DOCUMENT_TITLE = 'Kody'
export const NOT_FOUND_DOCUMENT_TITLE = 'Not found'

type DocumentHeadLink = {
	rel: string
	hrefPath: string
	type?: string
	title?: string
	/** Keep href origin-relative for same-origin assets (e.g. stylesheets under CSP). */
	sameOrigin?: boolean
}

type DocumentHeadOg = {
	title: string
	description: string
	imagePath: string
}

/**
 * Route-relative head descriptor. Paths stay origin-relative so the same
 * registry works for SSR (absolute URLs) and SPA updates (`location.origin`).
 */
export type DocumentHeadDescriptor = {
	title: string
	description?: string
	canonicalPath?: string
	og?: DocumentHeadOg
	links?: Array<DocumentHeadLink>
}

export type ResolvedDocumentHead = {
	title: string
	description?: string
	canonicalUrl?: string
	og?: {
		title: string
		description: string
		imageUrl: string
	}
	links?: Array<{
		rel: string
		href: string
		type?: string
		title?: string
	}>
}

/**
 * Bump when the shared OG renderer changes how every card looks. X, Slack and
 * Discord cache unfurl images by URL, so a new query value makes them refetch.
 * The OG handlers ignore the param.
 */
const OG_IMAGE_VERSION = '3'

function withOgImageVersion(path: string): string {
	if (path.startsWith('http://') || path.startsWith('https://')) return path
	return `${path}${path.includes('?') ? '&' : '?'}v=${OG_IMAGE_VERSION}`
}

export function absolutizeDocumentHead(
	descriptor: DocumentHeadDescriptor,
	origin: string,
): ResolvedDocumentHead {
	const normalizedOrigin = origin.replace(/\/$/, '')
	const toAbsolute = (path: string) =>
		path.startsWith('http://') || path.startsWith('https://')
			? path
			: `${normalizedOrigin}${path.startsWith('/') ? path : `/${path}`}`

	return {
		title: descriptor.title,
		description: descriptor.description,
		canonicalUrl: descriptor.canonicalPath
			? toAbsolute(descriptor.canonicalPath)
			: undefined,
		og: descriptor.og
			? {
					title: descriptor.og.title,
					description: descriptor.og.description,
					imageUrl: toAbsolute(withOgImageVersion(descriptor.og.imagePath)),
				}
			: undefined,
		links: descriptor.links?.map((link) => ({
			rel: link.rel,
			href: link.sameOrigin ? link.hrefPath : toAbsolute(link.hrefPath),
			type: link.type,
			title: link.title,
		})),
	}
}
