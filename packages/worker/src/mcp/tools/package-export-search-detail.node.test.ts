import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test } from 'vitest'
import { McpCallerError } from '#mcp/caller-error.ts'
import { type AuthoredPackageJson } from '#worker/package-registry/types.ts'

import { formatPackageExportEntityDetail } from './package-export-search-detail.ts'
import { formatEntityDetailMarkdown } from './search-format-detail.ts'
import { type SearchEntityDetail } from './search-format-types.ts'

function createHomeControlsDetail(
	section?: string,
): Extract<SearchEntityDetail, { type: 'package' }> {
	const manifest = {
		name: '@user/home-controls',
		exports: {
			'.': './src/index.ts',
			'./bond-area-shades': './src/bond-area-shades.ts',
		},
		kody: {
			id: 'home-controls',
			description: 'Home control helpers.',
		},
	} satisfies AuthoredPackageJson
	return {
		type: 'package',
		id: 'home-controls',
		title: '@user/home-controls',
		description: 'Home control helpers.',
		baseUrl: 'http://localhost',
		ownerUsername: 'user',
		hostedUrl: null,
		listingAhead: null,
		record: {
			id: 'package-home',
			userId: ownerIdFromStored('user-1'),
			name: '@user/home-controls',
			kodyId: 'home-controls',
			description: 'Home control helpers.',
			tags: ['home'],
			searchText: null,
			sourceId: 'source-home',
			hasApp: false,
			hasSkills: false,
			hidden: false,
			isPrivate: false,
			isInternetVisible: false,
			lockedAt: null,
			createdAt: '2026-03-20T00:00:00.000Z',
			updatedAt: '2026-03-20T00:00:00.000Z',
		},
		manifest,
		files: {
			'package.json': JSON.stringify(manifest),
			'README.md':
				'# Home controls\n\n## Intent\n\nControl shades and lights.\n',
			'src/index.ts':
				'/** Package root. */\nexport default function home() { return true }',
			'src/bond-area-shades.ts': `/**
 * Lower or raise Bond-controlled shades in one area.
 * Use when the caller already knows the area id.
 *
 * @param input - Area id and target position
 * @returns Shade positions after the move
 *
 * @example
 * import bondAreaShades from 'kody:@user/home-controls/bond-area-shades'
 *
 * const result = await bondAreaShades({ areaId: 'living', position: 'closed' })
 */
export default async function bondAreaShades(input: {
	areaId: string
	position: 'open' | 'closed'
}): Promise<{ areaId: string; position: 'open' | 'closed' }> {
	return input
}
`,
		},
		...(section ? { section } : {}),
	}
}

test('package heading detail returns one export contract without packageGet', () => {
	const hashed = formatEntityDetailMarkdown(
		createHomeControlsDetail('bond-area-shades'),
	)
	const dotted = formatEntityDetailMarkdown(
		createHomeControlsDetail('./bond-area-shades'),
	)
	expect(hashed.structured).toMatchObject({
		kind: 'entity',
		type: 'package',
		detailMode: 'export',
		entityRef: 'package:home-controls#bond-area-shades',
		packageId: 'package-home',
		kodyId: 'home-controls',
		name: '@user/home-controls',
		importSpecifier: 'kody:@user/home-controls/bond-area-shades',
		typeDefinition: expect.stringContaining('bondAreaShades'),
		example: expect.stringContaining(
			"import bondAreaShades from 'kody:@user/home-controls/bond-area-shades'",
		),
	})
	expect(hashed.structured).not.toHaveProperty('exports')
	expect(hashed.markdown).toContain('kody:@user/home-controls/bond-area-shades')
	expect(hashed.markdown).toContain('export default async function main')
	expect(hashed.markdown).not.toContain('| Subpath | Purpose |')
	expect(hashed.structured).toEqual(dotted.structured)
	expect(hashed.markdown).toBe(dotted.markdown)
	if (hashed.structured.type !== 'package') {
		throw new Error('expected package entity detail')
	}
	if (hashed.structured.detailMode !== 'export') {
		throw new Error('expected package export heading')
	}
	expect(hashed.structured.executeExample).toContain(
		'import action from "kody:@user/home-controls/bond-area-shades"',
	)
	expect(hashed.markdown).not.toContain('communityFork')

	const root = formatEntityDetailMarkdown(createHomeControlsDetail('.'))
	const dottedRoot = formatEntityDetailMarkdown(createHomeControlsDetail('./'))
	expect(root.structured).toMatchObject({
		kind: 'entity',
		type: 'package',
		detailMode: 'export',
		entityRef: 'package:home-controls#.',
		importSpecifier: 'kody:@user/home-controls',
	})
	expect(root.structured).toEqual(dottedRoot.structured)
	expect(root.markdown).toBe(dottedRoot.markdown)
})

const shadeDefinition =
	'export default async function bondAreaShades(input: ShadeInput): Promise<ShadeInput>'

function defaultFunction(description: string, typeDefinition: string) {
	return { name: 'default', description, typeDefinition, referencedTypes: [] }
}

function formatExport(
	exportDetail: Partial<
		Parameters<typeof formatPackageExportEntityDetail>[0]['exportDetail']
	>,
	options: Partial<Parameters<typeof formatPackageExportEntityDetail>[0]> = {},
) {
	return formatPackageExportEntityDetail({
		detail: createHomeControlsDetail('bond-area-shades'),
		exportDetail: {
			subpath: './bond-area-shades',
			runtimeTarget: 'src/bond-area-shades.ts',
			typesPath: null,
			description: 'Lower or raise Bond-controlled shades.',
			typeDefinition: shadeDefinition,
			functions: [
				defaultFunction(
					'Lower or raise Bond-controlled shades.',
					shadeDefinition,
				),
			],
			referencedTypes: [],
			...exportDetail,
		},
		...options,
	})
}

test('unknown package export heading is a clear per-entity caller error', () => {
	const format = () =>
		formatEntityDetailMarkdown(createHomeControlsDetail('missing-export'))
	expect(format).toThrow(McpCallerError)
	expect(format).toThrow(
		'Unknown export "missing-export" for package:home-controls. Available: ., ./bond-area-shades.',
	)
})

test('oversized referenced types keep the signature and type names', () => {
	const formatted = formatExport(
		{
			referencedTypes: [
				{
					name: 'ShadeInput',
					kind: 'type',
					definition: `type ShadeInput = {\n\t${'areaId: string; '.repeat(400)}\n}`,
				},
			],
		},
		{ maxChars: 1_200 },
	)
	expect(formatted.structured).toMatchObject({
		detailMode: 'export',
		typeDefinition: expect.stringContaining('bondAreaShades'),
		referencedTypesTruncated: true,
		referencedTypes: [{ name: 'ShadeInput', kind: 'type', definition: null }],
	})
	for (const text of [
		'bondAreaShades',
		'`ShadeInput`',
		'Referenced type definitions omitted (exceeds search response budget).',
		'packageGet({ package_id: "package-home" })',
	]) {
		expect(formatted.markdown).toContain(text)
	}
	expect(formatted.markdown.length).toBeLessThanOrEqual(1_200)
})

test('package file fragments focus headings and line ranges without replacing export subpaths', () => {
	const heading = formatEntityDetailMarkdown(
		createHomeControlsDetail('README.md#intent'),
	)
	expect(heading.structured).toMatchObject({
		detailMode: 'file',
		entityRef: 'package:home-controls#README.md#intent',
		path: 'README.md',
		anchor: {
			kind: 'heading',
			heading: { slug: 'intent', title: 'Intent' },
		},
	})
	if (
		!('detailMode' in heading.structured) ||
		heading.structured.detailMode !== 'file'
	) {
		throw new Error('expected package file detail')
	}
	expect(heading.structured.content).toContain('Control shades and lights.')
	expect(heading.structured.content).not.toContain('# Home controls')

	const exportStillWins = formatEntityDetailMarkdown(
		createHomeControlsDetail('bond-area-shades'),
	)
	expect(exportStillWins.structured).toMatchObject({ detailMode: 'export' })

	expect(() =>
		formatEntityDetailMarkdown(createHomeControlsDetail('src/missing.ts')),
	).toThrow(/Unknown file "src\/missing.ts"/)
})
