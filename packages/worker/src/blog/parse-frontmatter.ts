import {
	estimateReadingMinutes,
	getBlogCategory,
	getBlogSeries,
	reservedBlogSlugs,
	type BlogCategorySlug,
	type BlogSeriesSlug,
} from '#universal/blog-taxonomy.ts'
import { BLOG_IMAGE_PATTERN } from '#universal/blog-images.ts'

export type BlogPostFrontmatter = {
	title: string
	date: string
	/** Last meaningful revision (`YYYY-MM-DD`, not before `date`), or null. */
	updated: string | null
	description: string
	/** Tie-break for posts sharing a `date` (lower first). */
	order: number
	/** Exactly one category from `#universal/blog-taxonomy.ts`. */
	category: BlogCategorySlug
	/** Optional series from `#universal/blog-taxonomy.ts`; parts read by date. */
	series: BlogSeriesSlug | null
	/** Pins the post as the blog index hero. At most one post sets it. */
	featured: boolean
	/** Optional origin-relative artwork shown as the post headline. */
	image: string | null
	/** Accessible description required when `image` is present. */
	imageAlt: string | null
	/**
	 * Optional Satori-compatible artwork composed into the generated
	 * `/blog/:slug/og.png` card, matching guides. Headline `image` is not
	 * the Open Graph image.
	 */
	ogImage: string | null
}

export type BlogPost = BlogPostFrontmatter & {
	slug: string
	body: string
	readingMinutes: number
}

const KNOWN_KEYS = new Set([
	'title',
	'date',
	'updated',
	'description',
	'order',
	'category',
	'series',
	'featured',
	'image',
	'imageAlt',
	'ogImage',
])
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

function parseBooleanField(
	slug: string,
	key: string,
	value: string | undefined,
	fallback: boolean,
) {
	if (value === undefined) return fallback
	if (value !== 'true' && value !== 'false') {
		throw new Error(
			`Blog post "${slug}" has invalid frontmatter "${key}" (expected true or false).`,
		)
	}
	return value === 'true'
}

/**
 * Parse a blog markdown file with the fixed YAML-like frontmatter contract:
 *
 * ```
 * ---
 * title: <string>
 * date: YYYY-MM-DD
 * updated: YYYY-MM-DD (optional; not before date)
 * description: <string>
 * order: <number>
 * category: essays | how-to | updates | stories
 * series: <series slug> (optional)
 * featured: true | false (optional; default false)
 * image: /images/<file> (optional)
 * imageAlt: <string, required with image>
 * ogImage: /images/<file> (optional Satori artwork on the generated card)
 * ---
 * <markdown body>
 * ```
 *
 * Values may be inline (`key: value`) or a single-level indented block after
 * `key:` (joined with spaces). Blank lines are ignored. Throws on a missing
 * fence, an unknown key, a missing required field, or an invalid value
 * (including a category or series that is not in the taxonomy).
 */
export function parseBlogPostMarkdown(slug: string, raw: string): BlogPost {
	if (
		!SLUG_PATTERN.test(slug) ||
		(reservedBlogSlugs as ReadonlyArray<string>).includes(slug)
	) {
		throw new Error(
			`Blog post slug "${slug}" must be kebab-case and not one of: ${reservedBlogSlugs.join(', ')}.`,
		)
	}
	const normalized = raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
	if (!normalized.startsWith('---\n')) {
		throw new Error(`Blog post "${slug}" is missing opening frontmatter fence.`)
	}

	const endIndex = normalized.indexOf('\n---\n', 4)
	if (endIndex === -1) {
		throw new Error(`Blog post "${slug}" is missing closing frontmatter fence.`)
	}

	const frontmatterBlock = normalized.slice(4, endIndex)
	const body = normalized.slice(endIndex + '\n---\n'.length).replace(/^\n/, '')

	const fields = new Map<string, string>()
	let currentKey: string | null = null
	const currentParts: Array<string> = []

	function commitCurrentKey() {
		if (currentKey === null) return
		fields.set(currentKey, currentParts.join(' ').trim())
		currentKey = null
		currentParts.length = 0
	}

	for (const line of frontmatterBlock.split('\n')) {
		if (line.trim() === '') continue

		const indentedContinuation = /^(?: {2}|\t)\s*(.*)$/.exec(line)
		if (indentedContinuation && currentKey !== null) {
			const part = indentedContinuation[1]!.trim()
			// oxfmt rewraps a value containing ": " as a YAML complex key.
			if (/^[?:](?:\s|$)/.test(part)) {
				throw new Error(
					`Blog post "${slug}" has a YAML complex-key marker in frontmatter "${currentKey}" ("${part.slice(0, 1)}" line). Reword the value so it does not contain ": ".`,
				)
			}
			if (part) currentParts.push(part)
			continue
		}

		const colonIndex = line.indexOf(':')
		if (colonIndex === -1) {
			throw new Error(
				`Blog post "${slug}" has an invalid frontmatter line: ${line}`,
			)
		}

		commitCurrentKey()
		currentKey = line.slice(0, colonIndex).trim()
		if (!KNOWN_KEYS.has(currentKey)) {
			throw new Error(
				`Blog post "${slug}" has unknown frontmatter "${currentKey}" (allowed: ${[...KNOWN_KEYS].join(', ')}).`,
			)
		}
		const inlineValue = line.slice(colonIndex + 1).trim()
		if (inlineValue) {
			currentParts.push(inlineValue)
			commitCurrentKey()
		}
	}
	commitCurrentKey()

	const title = fields.get('title')
	const date = fields.get('date')
	const description = fields.get('description')
	const orderRaw = fields.get('order')
	const updated = fields.get('updated') ?? null
	const categoryRaw = fields.get('category')
	const seriesRaw = fields.get('series') ?? null
	const featuredRaw = fields.get('featured')
	const image = fields.get('image') ?? null
	const imageAlt = fields.get('imageAlt') ?? null
	const ogImageRaw = fields.get('ogImage') ?? null

	if (!title) {
		throw new Error(`Blog post "${slug}" is missing frontmatter "title".`)
	}
	if (!date) {
		throw new Error(`Blog post "${slug}" is missing frontmatter "date".`)
	}
	if (!DATE_PATTERN.test(date)) {
		throw new Error(
			`Blog post "${slug}" has invalid frontmatter "date" (expected YYYY-MM-DD).`,
		)
	}
	if (!description) {
		throw new Error(`Blog post "${slug}" is missing frontmatter "description".`)
	}
	if (orderRaw === undefined) {
		throw new Error(`Blog post "${slug}" is missing frontmatter "order".`)
	}
	if (!/^-?\d+$/.test(orderRaw)) {
		throw new Error(
			`Blog post "${slug}" has invalid frontmatter "order" (expected integer).`,
		)
	}

	if (updated !== null && (!DATE_PATTERN.test(updated) || updated < date)) {
		throw new Error(
			`Blog post "${slug}" has invalid frontmatter "updated" (expected YYYY-MM-DD on or after "date").`,
		)
	}
	if (!categoryRaw) {
		throw new Error(`Blog post "${slug}" is missing frontmatter "category".`)
	}
	const category = getBlogCategory(categoryRaw)
	if (!category) {
		throw new Error(
			`Blog post "${slug}" has unknown frontmatter "category" "${categoryRaw}" (see #universal/blog-taxonomy.ts).`,
		)
	}
	const series = seriesRaw === null ? null : getBlogSeries(seriesRaw)
	if (seriesRaw !== null && !series) {
		throw new Error(
			`Blog post "${slug}" has unknown frontmatter "series" "${seriesRaw}" (see #universal/blog-taxonomy.ts).`,
		)
	}

	const featured = parseBooleanField(slug, 'featured', featuredRaw, false)

	if (image !== null && !BLOG_IMAGE_PATTERN.test(image)) {
		throw new Error(
			`Blog post "${slug}" has invalid frontmatter "image" (expected an origin-relative /images/ asset path).`,
		)
	}
	if (image !== null && !imageAlt) {
		throw new Error(
			`Blog post "${slug}" is missing frontmatter "imageAlt" (required with "image").`,
		)
	}
	if (image === null && imageAlt !== null) {
		throw new Error(
			`Blog post "${slug}" has frontmatter "imageAlt" without an "image".`,
		)
	}
	if (ogImageRaw !== null && !BLOG_IMAGE_PATTERN.test(ogImageRaw)) {
		throw new Error(
			`Blog post "${slug}" has invalid frontmatter "ogImage" (expected an origin-relative /images/ asset path).`,
		)
	}

	return {
		slug,
		title,
		date,
		updated,
		description,
		order: Number(orderRaw),
		category: category.slug,
		series: series?.slug ?? null,
		featured,
		image,
		imageAlt,
		ogImage: ogImageRaw,
		body,
		readingMinutes: estimateReadingMinutes(body),
	}
}
