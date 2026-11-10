import {
	escapeMarkdownText,
	formatMarkdownInlineCode,
} from './markdown-safety.ts'
import type { SearchEntityDetailFormatOptions } from './search-entity-plugin.ts'
import type { SearchEntityDetailStructured } from './search-format-types.ts'

type GuideDetailStructured = Extract<
	SearchEntityDetailStructured,
	{ type: 'guide' }
>

type GuideSections = GuideDetailStructured['sections']

/**
 * Guide description and section list shared by every batch entry for that
 * guide, keyed in `structuredContent.guides` by `guide:{id}`.
 */
export type SearchBatchGuideMetadata = {
	id: string
	title: string
	description: string
	sections: GuideSections
	/** Set when the section list was dropped to fit requested bodies. */
	sectionsOmitted?: true
}

/**
 * A guide entry whose guide appears more than once in the batch: its
 * `description` and `sections` live once in `guides[guideMetadataRef]`.
 */
export type SearchBatchSharedGuideEntry = Omit<
	GuideDetailStructured,
	'description' | 'sections'
> & { guideMetadataRef: string }

export type SearchBatchEntryStructured =
	| SearchEntityDetailStructured
	| (GuideDetailStructured & { sectionsOmitted?: true })
	| SearchBatchSharedGuideEntry
	| { entityRef: string; error: string }

export type SearchBatchResolvedEntry<TDetail> =
	| { ok: true; entityRef: string; detail: TDetail }
	| { ok: false; entityRef: string; error: string }

type SearchBatchFormatted = {
	markdown: string
	structured: SearchEntityDetailStructured
}

export const batchOverflowError =
	'Omitted from batch response (exceeds size budget). Look up individually with search({ entity }).'

/**
 * Assembles an entity batch within `maxChars` of structured JSON. Guide
 * metadata repeated across entries is sent once per guide. When the budget
 * is tight, guide section lists are dropped before any requested body.
 */
export function buildEntityBatchResponse<TDetail>(input: {
	entries: ReadonlyArray<SearchBatchResolvedEntry<TDetail>>
	format: (
		detail: TDetail,
		options: Pick<SearchEntityDetailFormatOptions, 'omitSharedMetadata'>,
	) => SearchBatchFormatted
	maxChars: number
}) {
	const items = input.entries.map((entry) => {
		if (!entry.ok) return { ...entry, formatted: null }
		try {
			return {
				...entry,
				formatted: input.format(entry.detail, { omitSharedMetadata: false }),
			}
		} catch (cause) {
			return {
				ok: false as const,
				entityRef: entry.entityRef,
				error: cause instanceof Error ? cause.message : String(cause),
				formatCause: cause,
				formatted: null,
			}
		}
	})

	const accepted = new Set<number>()
	let omitSections = false
	const measure = (candidate: Set<number>, withoutSections: boolean) =>
		JSON.stringify(assembleStructured(items, candidate, withoutSections)).length
	items.forEach((item, index) => {
		if (!item.formatted) return
		const candidate = new Set([...accepted, index])
		if (
			accepted.size === 0 ||
			measure(candidate, omitSections) <= input.maxChars
		) {
			accepted.add(index)
			return
		}
		if (!omitSections && measure(candidate, true) <= input.maxChars) {
			omitSections = true
			accepted.add(index)
		}
	})

	const { result, guides } = assembleStructured(items, accepted, omitSections)
	const sharedGuideIds = new Set(
		Object.values(guides).map((metadata) => metadata.id),
	)
	const shownGuideIds = new Set<string>()
	const markdownParts = items.map((item, index) => {
		if (!item.formatted) return errorMarkdown(item.entityRef, item.error)
		if (!accepted.has(index)) {
			return errorMarkdown(item.entityRef, batchOverflowError)
		}
		const structured = item.formatted.structured
		if (structured.type !== 'guide' || !sharedGuideIds.has(structured.id)) {
			return item.formatted.markdown
		}
		if (!shownGuideIds.has(structured.id)) {
			shownGuideIds.add(structured.id)
			return item.formatted.markdown
		}
		return input.format(item.detail as TDetail, { omitSharedMetadata: true })
			.markdown
	})

	return {
		result,
		guides: Object.keys(guides).length > 0 ? guides : null,
		markdownParts,
		accepted: items.flatMap((item, index) =>
			item.formatted && accepted.has(index)
				? [
						{
							detail: item.detail as TDetail,
							structured: item.formatted.structured,
						},
					]
				: [],
		),
		/** Entries that resolved but failed to format (e.g. unknown heading). */
		formatFailures: items.flatMap((item) =>
			!item.formatted && 'formatCause' in item
				? [
						{
							entityRef: item.entityRef,
							error: item.error,
							cause: item.formatCause,
						},
					]
				: [],
		),
	}
}

function errorMarkdown(entityRef: string, error: string) {
	return `Error resolving ${formatMarkdownInlineCode(entityRef)}: ${escapeMarkdownText(error)}`
}

function assembleStructured(
	items: ReadonlyArray<
		| { entityRef: string; formatted: SearchBatchFormatted }
		| { entityRef: string; error: string; formatted: null }
	>,
	accepted: ReadonlySet<number>,
	omitSections: boolean,
) {
	const guideCounts = new Map<string, number>()
	for (const index of accepted) {
		const structured = items[index]?.formatted?.structured
		if (structured?.type !== 'guide') continue
		guideCounts.set(structured.id, (guideCounts.get(structured.id) ?? 0) + 1)
	}
	const guides: Record<string, SearchBatchGuideMetadata> = {}
	const result: Array<SearchBatchEntryStructured> = items.map((item, index) => {
		if (!item.formatted) {
			return { entityRef: item.entityRef, error: item.error }
		}
		if (!accepted.has(index)) {
			return { entityRef: item.entityRef, error: batchOverflowError }
		}
		const structured = item.formatted.structured
		if (structured.type !== 'guide') return structured
		const sections = omitSections ? [] : structured.sections
		const sectionsFlag = omitSections ? { sectionsOmitted: true as const } : {}
		if ((guideCounts.get(structured.id) ?? 0) < 2) {
			return { ...structured, sections, ...sectionsFlag }
		}
		const guideMetadataRef = `guide:${structured.id}`
		guides[guideMetadataRef] ??= {
			id: structured.id,
			title: structured.title,
			description: structured.description,
			sections,
			...sectionsFlag,
		}
		const {
			description: _description,
			sections: _sections,
			...entry
		} = structured
		return { ...entry, guideMetadataRef }
	})
	return { result, guides }
}
