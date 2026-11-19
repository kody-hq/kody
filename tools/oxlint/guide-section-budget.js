import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { cwd as processCwd } from 'node:process'

/**
 * Must match `maxChars` in
 * `packages/worker/src/mcp/tools/search-constants.ts`.
 */
const maxGuideSectionChars = 6_000 * 4
const guideContentsModeLine =
	'- Contents: oversized guide; open a heading with `guide:{id}#{slug}`'

const headingLinePattern = /^(#{1,6})\s+(.+?)\s*$/
const fencedBlockPattern = /^(`{3,}|~{3,})/
const officialGuideFilePattern = /\.md$/
const skipGuideNames = new Set(['README.md'])

function stripGuideFrontmatter(raw) {
	return parseGuideLintSource(raw).body
}

function parseGuideLintMetadata(raw, slug) {
	const parsed = parseGuideLintSource(raw)
	return {
		id: parsed.fields.get('id') || slug,
		description: parsed.fields.get('summary') || '',
		category: parsed.fields.get('category') || 'platform',
		slug,
		provider: parsed.fields.get('provider') ?? null,
		lastVerified: parsed.fields.get('lastVerified') ?? null,
	}
}

function guideSectionModeLine(slug) {
	return `- Section: \`${slug}\``
}

function buildGuideDetailHeaderLines(input) {
	return [
		`# Guide — \`${input.id}\``,
		'',
		input.description,
		'',
		'## Summary',
		'',
		`- Entity: \`guide:${input.id}\``,
		`- Category: \`${input.category}\``,
		`- Web: \`${input.slug === 'what-is-kody' ? '/docs' : `/docs/${input.slug}`}\``,
		...(input.provider ? [`- Provider: ${input.provider}`] : []),
		...(input.lastVerified
			? [`- Last verified: \`${input.lastVerified}\``]
			: []),
	]
}

function guideSearchBodyBudget(input, maxChars = maxGuideSectionChars) {
	const header = buildGuideDetailHeaderLines(input).join('\n')
	const mode = Math.max(
		guideContentsModeLine.length,
		guideSectionModeLine(input.section ?? 'section').length,
	)
	return Math.max(0, maxChars - header.length - mode - 3)
}

function slugifyDocumentHeading(title) {
	return normalizeHeadingKey(title)
		.replace(/[^\p{L}\p{N}._-]+/gu, '-')
		.replace(/-+/g, '-')
		.replace(/^-+|-+$/g, '')
}

function parseDocumentHeadings(markdown) {
	const lines = markdown.split('\n')
	const parsed = []
	let fence = null

	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index] ?? ''
		const fenceMatch = line.match(fencedBlockPattern)
		if (fenceMatch) {
			const marker = fenceMatch[1] ?? ''
			if (fence == null) {
				fence = marker
			} else if (
				marker[0] === fence[0] &&
				marker.length >= fence.length &&
				line.slice(marker.length).trim() === ''
			) {
				fence = null
			}
			continue
		}
		if (fence != null) continue

		const headingMatch = line.match(headingLinePattern)
		if (!headingMatch) continue
		const marks = headingMatch[1] ?? ''
		const rawTitle = headingMatch[2] ?? ''
		parsed.push({
			level: marks.length,
			title: rawTitle.replace(/\s+#+\s*$/, '').trim(),
			start: index,
		})
	}

	const usedSlugs = new Map()
	return parsed.map((heading, index) => {
		const nextSameOrHigher = parsed
			.slice(index + 1)
			.find((candidate) => candidate.level <= heading.level)
		const baseSlug = slugifyDocumentHeading(heading.title) || 'section'
		const seen = usedSlugs.get(baseSlug) ?? 0
		usedSlugs.set(baseSlug, seen + 1)
		return {
			...heading,
			slug: seen === 0 ? baseSlug : `${baseSlug}-${String(seen + 1)}`,
			end: nextSameOrHigher?.start ?? lines.length,
		}
	})
}

function findOversizedDocumentSections(markdown, limit = maxGuideSectionChars) {
	const limitFor = typeof limit === 'function' ? limit : () => limit
	const headings = parseDocumentHeadings(markdown)
	const lines = markdown.split('\n')
	const requestable = headings.filter((heading) => heading.level >= 2)
	const toCheck = requestable.length > 0 ? requestable : headings
	if (toCheck.length === 0) {
		const documentLimit = limitFor({ slug: '(document)', title: '(document)' })
		if (markdown.length > documentLimit) {
			return [
				{
					slug: '(document)',
					title: '(document)',
					level: 0,
					chars: markdown.length,
					limit: documentLimit,
				},
			]
		}
		return []
	}
	return toCheck
		.map((heading) => {
			const chars = lines.slice(heading.start, heading.end).join('\n').length
			const sectionLimit = limitFor(heading)
			return {
				slug: heading.slug,
				title: heading.title,
				level: heading.level,
				chars,
				limit: sectionLimit,
			}
		})
		.filter((section) => section.chars > section.limit)
}

export function findOversizedOfficialGuideSections(
	root = processCwd(),
	maxChars = maxGuideSectionChars,
) {
	const guidesDir = path.join(root, 'docs/guides')
	const overflows = []
	for (const file of listOfficialGuideFiles(guidesDir)) {
		const raw = readFileSync(file, 'utf8')
		const slug = path.basename(file, '.md')
		const meta = parseGuideLintMetadata(raw, slug)
		const body = stripGuideFrontmatter(raw)
		const relative = path.relative(root, file).replaceAll('\\', '/')
		for (const section of findOversizedDocumentSections(body, (heading) =>
			guideSearchBodyBudget({ ...meta, section: heading.slug }, maxChars),
		)) {
			overflows.push({ file: relative, ...section })
		}
	}
	return overflows
}

export function isOfficialGuideCatalogFile(filename, cwd = processCwd()) {
	const relative =
		typeof filename === 'string' && path.isAbsolute(filename)
			? path.relative(cwd, filename).replaceAll('\\', '/')
			: String(filename ?? '').replaceAll('\\', '/')
	return relative === 'packages/worker/src/guides/catalog.ts'
}

function listOfficialGuideFiles(dir) {
	const files = []
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const next = path.join(dir, entry.name)
		if (entry.isDirectory()) {
			files.push(...listOfficialGuideFiles(next))
			continue
		}
		if (!officialGuideFilePattern.test(entry.name)) continue
		if (skipGuideNames.has(entry.name)) continue
		files.push(next)
	}
	return files
}

function parseGuideLintSource(raw) {
	const normalized = raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
	if (!normalized.startsWith('---\n')) {
		return { fields: new Map(), body: normalized }
	}
	const endIndex = normalized.indexOf('\n---\n', 4)
	if (endIndex === -1) {
		return { fields: new Map(), body: normalized }
	}
	const frontmatterBlock = normalized.slice(4, endIndex)
	const body = normalized.slice(endIndex + '\n---\n'.length).replace(/^\n/, '')
	const fields = new Map()
	let currentKey = null
	const currentParts = []

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
			const part = indentedContinuation[1]?.trim()
			if (part) currentParts.push(part)
			continue
		}
		const colonIndex = line.indexOf(':')
		if (colonIndex === -1) continue
		commitCurrentKey()
		currentKey = line.slice(0, colonIndex).trim()
		const inlineValue = line.slice(colonIndex + 1).trim()
		if (inlineValue) {
			currentParts.push(inlineValue)
			commitCurrentKey()
		}
	}
	commitCurrentKey()
	return { fields, body }
}

function normalizeHeadingKey(value) {
	return value
		.replace(/[`*_~]/g, '')
		.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
		.replace(/\s+/g, ' ')
		.trim()
		.toLowerCase()
}
