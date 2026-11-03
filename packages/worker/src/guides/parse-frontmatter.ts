import type { Guide, GuideAudience } from './guide-types.ts'

export type {
	GuideAudience,
	GuideCategory,
	GuideFrontmatter,
	Guide,
	GuideMetadata,
} from './guide-types.ts'

const GUIDE_ID_PATTERN = /^[a-z][a-z0-9_]*$/
const LAST_VERIFIED_PATTERN = /^\d{4}-(?:0[1-9]|1[0-2])$/
const GUIDE_IMAGE_PATTERN =
	/^\/images\/[a-z0-9][a-z0-9/-]*\.(?:avif|jpe?g|png|webp)$/

/**
 * Parse a guide markdown file with the fixed frontmatter contract:
 *
 * ```
 * ---
 * id: integration_bootstrap
 * title: <string>
 * summary: <string, may continue on indented lines>
 * category: platform | provider
 * image: /images/<file> (optional)
 * imageAlt: <string, required with image>
 * ogImage: /images/<file> (optional)
 * provider: <string, provider guides only>
 * lastVerified: YYYY-MM (required when category is provider)
 * audience: everyone | agents (optional; agents = playbook the agent follows)
 * unadvertised: true | false (optional)
 * adminOnly: true | false (optional; website + search only for signed-in admins)
 * ---
 * <markdown body>
 * ```
 *
 * Values may be inline (`key: value`) or a single-level indented block after
 * `key:` (joined with spaces). Unknown keys and blank lines are ignored.
 * Throws on missing fence, missing required fields, or invalid values.
 */
export function parseGuideMarkdown(slug: string, raw: string): Guide {
	const normalized = raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
	if (!normalized.startsWith('---\n')) {
		throw new Error(`Guide "${slug}" is missing opening frontmatter fence.`)
	}

	const endIndex = normalized.indexOf('\n---\n', 4)
	if (endIndex === -1) {
		throw new Error(`Guide "${slug}" is missing closing frontmatter fence.`)
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
			if (part) currentParts.push(part)
			continue
		}

		const colonIndex = line.indexOf(':')
		if (colonIndex === -1) {
			throw new Error(
				`Guide "${slug}" has an invalid frontmatter line: ${line}`,
			)
		}

		commitCurrentKey()
		currentKey = line.slice(0, colonIndex).trim()
		const inlineValue = line.slice(colonIndex + 1).trim()
		if (inlineValue) {
			currentParts.push(inlineValue)
			commitCurrentKey()
		}
	}
	commitCurrentKey()

	const id = fields.get('id')
	const title = fields.get('title')
	const summary = fields.get('summary')
	const category = fields.get('category')
	const image = fields.get('image') ?? null
	const imageAlt = fields.get('imageAlt') ?? null
	const ogImage = fields.get('ogImage') ?? null
	const provider = fields.get('provider') ?? null
	const lastVerified = fields.get('lastVerified') ?? null
	const unadvertisedField = fields.get('unadvertised') ?? null
	let unadvertised = false
	if (unadvertisedField !== null) {
		if (unadvertisedField !== 'true' && unadvertisedField !== 'false') {
			throw new Error(
				`Guide "${slug}" has invalid frontmatter "unadvertised" (expected true or false).`,
			)
		}
		unadvertised = unadvertisedField === 'true'
	}
	const adminOnlyField = fields.get('adminOnly') ?? null
	let adminOnly = false
	if (adminOnlyField !== null) {
		if (adminOnlyField !== 'true' && adminOnlyField !== 'false') {
			throw new Error(
				`Guide "${slug}" has invalid frontmatter "adminOnly" (expected true or false).`,
			)
		}
		adminOnly = adminOnlyField === 'true'
	}
	if (unadvertised && adminOnly) {
		throw new Error(
			`Guide "${slug}" cannot set both frontmatter "unadvertised" and "adminOnly".`,
		)
	}
	const audienceField = fields.get('audience') ?? 'everyone'
	if (audienceField !== 'everyone' && audienceField !== 'agents') {
		throw new Error(
			`Guide "${slug}" has invalid frontmatter "audience" (expected "everyone" or "agents").`,
		)
	}
	const audience: GuideAudience = audienceField

	if (!id) {
		throw new Error(`Guide "${slug}" is missing frontmatter "id".`)
	}
	if (!GUIDE_ID_PATTERN.test(id)) {
		throw new Error(
			`Guide "${slug}" has invalid frontmatter "id" (expected snake_case).`,
		)
	}
	if (!title) {
		throw new Error(`Guide "${slug}" is missing frontmatter "title".`)
	}
	if (!summary) {
		throw new Error(`Guide "${slug}" is missing frontmatter "summary".`)
	}
	if (category !== 'platform' && category !== 'provider') {
		throw new Error(
			`Guide "${slug}" has invalid frontmatter "category" (expected "platform" or "provider").`,
		)
	}
	if (image !== null && !GUIDE_IMAGE_PATTERN.test(image)) {
		throw new Error(
			`Guide "${slug}" has invalid frontmatter "image" (expected an origin-relative /images/ asset path).`,
		)
	}
	if (image !== null && !imageAlt) {
		throw new Error(
			`Guide "${slug}" is missing frontmatter "imageAlt" (required with "image").`,
		)
	}
	if (image === null && imageAlt !== null) {
		throw new Error(
			`Guide "${slug}" has frontmatter "imageAlt" without an "image".`,
		)
	}
	if (ogImage !== null && !GUIDE_IMAGE_PATTERN.test(ogImage)) {
		throw new Error(
			`Guide "${slug}" has invalid frontmatter "ogImage" (expected an origin-relative /images/ asset path).`,
		)
	}
	if (category === 'provider' && !provider) {
		throw new Error(
			`Guide "${slug}" is missing frontmatter "provider" (required for provider guides).`,
		)
	}
	if (category === 'provider' && !lastVerified) {
		throw new Error(
			`Guide "${slug}" is missing frontmatter "lastVerified" (required for provider guides).`,
		)
	}
	if (lastVerified !== null && !LAST_VERIFIED_PATTERN.test(lastVerified)) {
		throw new Error(
			`Guide "${slug}" has invalid frontmatter "lastVerified" (expected YYYY-MM).`,
		)
	}

	return {
		slug,
		id,
		title,
		summary,
		category,
		image,
		imageAlt,
		ogImage,
		provider,
		lastVerified,
		unadvertised,
		adminOnly,
		audience,
		body,
	}
}
