import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { callerHasRole } from '#mcp/capabilities/access-control.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { maxChars } from '#mcp/tools/search-constants.ts'
import { resolveMarkdownDocument } from '#worker/guides/document-sections.ts'
import {
	guideMetadataList,
	importGuideCatalog,
} from '#worker/guide-catalog-modules.ts'

/**
 * Guide markdown is bundled from `docs/guides/` at build time (see
 * `#worker/guides/catalog.ts` for the web-facing catalog), so this
 * capability, search `guide:{id}` entities, the `/docs` web pages, and
 * the raw `text/markdown` responses always serve the same deployed content
 * with no request-time GitHub dependency.
 *
 * Only `guideMetadataList` (frontmatter, no bodies) is statically imported
 * here — registering `codingGuideGet` must not add every guide body's
 * parse/link cost to every platform/runtime Worker isolate's main-module
 * cold start. The full catalog is loaded lazily by `importGuideCatalog()`
 * inside the handler; see `#worker/guide-catalog-modules.ts`.
 */

const advertisedGuides = guideMetadataList.filter(
	(guide) => !guide.unadvertised && !guide.adminOnly,
)

function buildCapabilityDescription(): string {
	return [
		'Load an official Kody guide from execute-module code (markdown, bundled from the kody repository).',
		'Prefer `search({ entity: "guide:{id}" })` to read a guide — do not execute this capability just to load documentation. Oversized guides return a table of contents; pass `section` or use `guide:{id}#{slug}` on search. Line anchors use `section: "L165"` or `section: "L165-L180"` (same as `guide:{id}#L165`).',
		'Use this from execute-module code when you need the markdown body programmatically.',
		'The `guide` input lists each available id. Discover guides with `search({ query: "… guide" })`.',
	].join('\n')
}

const unknownGuideError = 'Unknown Kody guide.'

const guideFieldSchema = z
	.string()
	.min(1)
	.describe(
		[
			'Which guide to load.',
			...advertisedGuides.map((guide) => `\`${guide.id}\`: ${guide.summary}`),
		].join(' '),
	)

const inputSchema = z.object({
	guide: guideFieldSchema,
	section: z
		.string()
		.min(1)
		.optional()
		.describe(
			'Optional heading title or slug, or a line anchor (`L165`, `L165-L180`). Oversized guides return a table of contents until a heading is requested. A missing heading or line fails instead of returning the whole guide.',
		),
})

const outputSchema = z.object({
	title: z.string().describe('Guide title.'),
	body: z
		.string()
		.describe(
			'Markdown body, a heading section, or a table of contents when the bundled guide exceeds the search response budget.',
		),
	bodyMode: z
		.enum(['full', 'toc', 'section', 'lines'])
		.describe(
			'Whether body is the full guide, a contents index, one requested heading, or a line anchor.',
		),
	section: z
		.object({
			title: z.string(),
			slug: z.string(),
		})
		.nullable()
		.describe('The resolved heading when bodyMode is section.'),
	lines: z
		.object({
			startLine: z.number().int(),
			endLine: z.number().int(),
			requestedStartLine: z.number().int(),
			requestedEndLine: z.number().int(),
			totalLines: z.number().int(),
		})
		.nullable()
		.describe(
			'The resolved line window when bodyMode is lines. startLine/endLine include context around a single requested line.',
		),
	sections: z
		.array(
			z.object({
				title: z.string(),
				slug: z.string(),
				level: z.number().int(),
			}),
		)
		.describe(
			'Headings that can be requested with section or guide:{id}#{slug}. Line anchors use L165 or L165-L180.',
		),
})

const allKeywords = [
	'codingGuideGet',
	'official guide capability',
	'load guide from execute',
]

export const kodyOfficialGuideCapability = defineDomainCapability(
	capabilityDomainNames.coding,
	{
		name: 'codingGuideGet',
		contextRuns: 'allow',
		orgPermission: 'none',
		description: buildCapabilityDescription(),
		keywords: [...allKeywords],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema,
		outputSchema,
		async handler(args, ctx: CapabilityContext) {
			const { guides } = await importGuideCatalog()
			const guide = guides.find((candidate) => candidate.id === args.guide)
			if (
				!guide ||
				(guide.adminOnly && !callerHasRole(ctx.callerContext, 'admin'))
			) {
				throw new Error(unknownGuideError)
			}
			const resolved = resolveMarkdownDocument({
				markdown: guide.body,
				maxChars,
				entityRef: `guide:${guide.id}`,
				...(args.section ? { section: args.section } : {}),
			})
			return {
				title: guide.title,
				body: resolved.markdown,
				bodyMode: resolved.mode,
				section: resolved.selected
					? {
							title: resolved.selected.title,
							slug: resolved.selected.slug,
						}
					: null,
				lines: resolved.lines,
				sections: resolved.headings
					.filter((heading) => heading.level >= 2)
					.map((heading) => ({
						title: heading.title,
						slug: heading.slug,
						level: heading.level,
					})),
			}
		},
	},
)
