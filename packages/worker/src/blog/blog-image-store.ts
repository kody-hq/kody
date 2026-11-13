/**
 * Weekly blog screenshots live in Cloudflare R2, not the git tree. The
 * `kody-community-assets` bucket (worker binding `COMMUNITY_ASSETS`) holds
 * them under the `blog-images/` prefix, and the worker serves them at the
 * same origin-relative path a git-backed file would use:
 *
 *   GET /images/blog/<slug>/<file>  ->  COMMUNITY_ASSETS `blog-images/<slug>/<file>`
 *
 * so the `img-src 'self'` CSP and the blog `image` frontmatter rule
 * (`BLOG_IMAGE_PATTERN`) keep working. Objects are uploaded out of band by
 * the weekly post automation with content-addressed file names, so they are
 * cached as immutable.
 */
export const BLOG_IMAGE_R2_PREFIX = 'blog-images/'

export const BLOG_IMAGE_CACHE_CONTROL = 'public, max-age=31536000, immutable'

const SLUG = /^[a-z0-9][a-z0-9-]{0,127}$/
const FILE = /^[a-z0-9][a-z0-9-]{0,127}\.(avif|jpe?g|png|webp)$/

const CONTENT_TYPES: Record<string, string> = {
	avif: 'image/avif',
	jpeg: 'image/jpeg',
	jpg: 'image/jpeg',
	png: 'image/png',
	webp: 'image/webp',
}

/**
 * R2 key and content type for a `/images/blog/<slug>/<file>` request, or
 * null when the params are not a valid blog image name (lowercase letters,
 * digits, and dashes, image extension only).
 */
export function blogImageObject(params: {
	slug: string
	file: string
}): { key: string; contentType: string } | null {
	const slug = String(params.slug ?? '')
	const file = String(params.file ?? '')
	if (!SLUG.test(slug)) return null
	const match = FILE.exec(file)
	if (!match) return null
	const contentType = CONTENT_TYPES[match[1]!]
	if (!contentType) return null
	return { key: `${BLOG_IMAGE_R2_PREFIX}${slug}/${file}`, contentType }
}
