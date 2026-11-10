import { expect, test } from 'vitest'
import { McpCallerError } from '#mcp/caller-error.ts'
import {
	batchOverflowError,
	buildEntityBatchResponse,
} from './search-entity-batch.ts'
import type { SearchEntityDetailStructured } from './search-format-types.ts'

type FakeDetail = {
	guideId: string
	slug: string
	bodyChars: number
	fail?: boolean
}

const sections = Array.from({ length: 18 }, (_, index) => ({
	title: `Section ${index}`,
	slug: `section-${index}`,
	level: 2,
	entityRef: `guide:shared#section-${index}`,
}))

function format(detail: FakeDetail, options: { omitSharedMetadata?: boolean }) {
	if (detail.fail) throw new McpCallerError(`Unknown heading ${detail.slug}`)
	const description = `${detail.guideId} description `.repeat(20)
	const structured: SearchEntityDetailStructured = {
		kind: 'entity',
		type: 'guide',
		id: detail.guideId,
		entityRef: `guide:${detail.guideId}#${detail.slug}`,
		title: detail.guideId,
		description,
		usage: `search({ entity: "guide:${detail.guideId}#${detail.slug}" })`,
		category: 'platform',
		slug: detail.guideId,
		body: 'x'.repeat(detail.bodyChars),
		bodyMode: 'section',
		section: { title: detail.slug, slug: detail.slug },
		lines: null,
		sections,
		provider: null,
		lastVerified: null,
	}
	return {
		markdown: options.omitSharedMetadata
			? `repeat:${detail.slug}`
			: `${description}\n${detail.slug}`,
		structured,
	}
}

function entries(details: Array<FakeDetail>) {
	return details.map((detail) => ({
		ok: true as const,
		entityRef: `guide:${detail.guideId}#${detail.slug}`,
		detail,
	}))
}

function measureLegacy(details: Array<FakeDetail>) {
	return JSON.stringify(details.map((detail) => format(detail, {}).structured))
		.length
}

test('repeated guide metadata is sent once and referenced by each entry', () => {
	const details = ['a', 'b', 'c'].map((slug) => ({
		guideId: 'shared',
		slug,
		bodyChars: 100,
	}))
	const batch = buildEntityBatchResponse({
		entries: entries(details),
		format,
		maxChars: 24_000,
	})
	expect(batch.guides).toEqual({
		'guide:shared': {
			id: 'shared',
			title: 'shared',
			description: expect.stringContaining('shared description'),
			sections,
		},
	})
	expect(batch.result).toEqual(
		details.map((detail) =>
			expect.objectContaining({
				entityRef: `guide:shared#${detail.slug}`,
				body: 'x'.repeat(100),
				guideMetadataRef: 'guide:shared',
			}),
		),
	)
	for (const entry of batch.result) {
		expect(entry).not.toHaveProperty('description')
		expect(entry).not.toHaveProperty('sections')
	}
	expect(batch.markdownParts).toEqual([
		expect.stringContaining('shared description'),
		'repeat:b',
		'repeat:c',
	])
	expect(batch.accepted).toHaveLength(3)
})

test('a guide that appears once keeps the full entry shape', () => {
	const details = [
		{ guideId: 'one', slug: 'a', bodyChars: 10 },
		{ guideId: 'two', slug: 'b', bodyChars: 10 },
	]
	const batch = buildEntityBatchResponse({
		entries: entries(details),
		format,
		maxChars: 24_000,
	})
	expect(batch.guides).toBeNull()
	expect(batch.result).toEqual(
		details.map((detail) => format(detail, {}).structured),
	)
})

test('six requested sections fit once metadata is no longer repeated', () => {
	const details = Array.from({ length: 6 }, (_, index) => ({
		guideId: 'shared',
		slug: `s${index}`,
		bodyChars: 1_500,
	}))
	const maxChars = 15_000
	expect(measureLegacy(details)).toBeGreaterThan(maxChars)
	const batch = buildEntityBatchResponse({
		entries: entries(details),
		format,
		maxChars,
	})
	expect(batch.result.filter((entry) => 'error' in entry)).toEqual([])
	expect(
		JSON.stringify({ result: batch.result, guides: batch.guides }).length,
	).toBeLessThanOrEqual(maxChars)
})

test('tight budgets drop guide section lists before a requested body', () => {
	const details = [
		{ guideId: 'one', slug: 'a', bodyChars: 2_000 },
		{ guideId: 'two', slug: 'b', bodyChars: 2_000 },
	]
	const full = measureLegacy(details)
	const sectionsChars = JSON.stringify(sections).length
	const maxChars = full - sectionsChars
	const batch = buildEntityBatchResponse({
		entries: entries(details),
		format,
		maxChars,
	})
	expect(batch.result).toEqual(
		details.map((detail) =>
			expect.objectContaining({
				entityRef: `guide:${detail.guideId}#${detail.slug}`,
				body: 'x'.repeat(2_000),
				sections: [],
				sectionsOmitted: true,
			}),
		),
	)

	const tooBig = buildEntityBatchResponse({
		entries: entries([
			{ guideId: 'one', slug: 'a', bodyChars: 2_000 },
			{ guideId: 'two', slug: 'b', bodyChars: 20_000 },
		]),
		format,
		maxChars: 10_000,
	})
	expect(tooBig.result[1]).toEqual({
		entityRef: 'guide:two#b',
		error: batchOverflowError,
	})
	expect(tooBig.result[0]).toMatchObject({ sections })
	expect(tooBig.accepted).toHaveLength(1)
})

test('a format failure becomes a per-entry error instead of failing the batch', () => {
	const batch = buildEntityBatchResponse({
		entries: [
			...entries([{ guideId: 'one', slug: 'a', bodyChars: 10 }]),
			...entries([{ guideId: 'one', slug: 'nope', bodyChars: 10, fail: true }]),
			{ ok: false as const, entityRef: 'guide:missing', error: 'not found' },
		],
		format,
		maxChars: 24_000,
	})
	expect(batch.result).toEqual([
		expect.objectContaining({ entityRef: 'guide:one#a', sections }),
		{ entityRef: 'guide:one#nope', error: 'Unknown heading nope' },
		{ entityRef: 'guide:missing', error: 'not found' },
	])
	expect(batch.guides).toBeNull()
	expect(batch.formatFailures).toEqual([
		expect.objectContaining({
			entityRef: 'guide:one#nope',
			cause: expect.any(McpCallerError),
		}),
	])
	expect(batch.markdownParts[1]).toMatch(/^Error resolving/)
})
