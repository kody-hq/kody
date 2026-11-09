import { expect, test } from 'vitest'
import {
	buildPackageSearchProjection,
	parseAuthoredPackageJson,
} from './manifest.ts'

function projectExport(files: Record<string, string>) {
	const manifest = parseAuthoredPackageJson({
		content: JSON.stringify({
			name: '@kentcdodds/schema-tools',
			exports: { '.': './src/index.ts' },
			kody: { id: 'schema-tools', description: 'Schema tools.' },
		}),
		mode: 'published',
	})
	const [exportDetail] = buildPackageSearchProjection(manifest, files).exports
	return exportDetail
}

function definitionOf(
	exportDetail: ReturnType<typeof projectExport>,
	name: string,
) {
	return exportDetail?.referencedTypes.find((type) => type.name === name)
		?.definition
}

test('params derived from a data-schema object resolve to their fields', () => {
	const exportDetail = projectExport({
		'src/index.ts': `import { array, object, optional, parse, string, type InferInput } from 'remix/data-schema'

type SchemaParams<S> = InferInput<S>

const LabelSchema = object({ name: string() }, { unknownKeys: 'error' })

export const CreateIssueInputSchema = object(
	{
		/** Repository owner (user or org). */
		owner: string(),
		repo: string(),
		title: string(),
		body: optional(string()),
		labels: optional(array(LabelSchema)),
	},
	{ unknownKeys: 'error' },
)

export type CreateIssueParams = SchemaParams<typeof CreateIssueInputSchema>

export default async function createIssue(raw: CreateIssueParams) {
	return parse(CreateIssueInputSchema, raw)
}
`,
	})
	expect(
		exportDetail?.referencedTypes.map((type) => [type.name, type.kind]),
	).toEqual([
		['CreateIssueParams', 'type'],
		['SchemaParams', 'type'],
		['CreateIssueInputSchema', 'const'],
	])
	expect(definitionOf(exportDetail, 'CreateIssueInputSchema')).toBe(
		[
			'// typeof CreateIssueInputSchema resolves to this schema input (unknown keys rejected):',
			'{',
			'\t/** Repository owner (user or org). */',
			'\towner: string',
			'\trepo: string',
			'\ttitle: string',
			'\tbody?: string',
			'\tlabels?: Array<{',
			'\t\tname: string',
			'\t}>',
			'}',
		].join('\n'),
	)
})

test('zod-like inferred types resolve chained modifiers and imported schemas', () => {
	const exportDetail = projectExport({
		'src/schemas.ts': `import { z } from 'zod'

export const SearchSchema = z
	.object({
		q: z.string().min(1).describe('Search query'),
		limit: z.number().int().optional(),
		sort: z.enum(['new', 'top']).default('new'),
		cursor: z.string().nullish(),
	})
	.strict()
`,
		'src/index.ts': `import type { z } from 'zod'
import { SearchSchema } from './schemas.ts'

export type SearchParams = z.infer<typeof SearchSchema>

export function search(params: SearchParams): Promise<unknown> {
	return Promise.resolve(params)
}
`,
	})
	expect(definitionOf(exportDetail, 'SearchSchema')).toBe(
		[
			'// typeof SearchSchema resolves to this schema input (unknown keys rejected):',
			'{',
			'\t/** Search query */',
			'\tq: string',
			'\tlimit?: number',
			"\tsort?: 'new' | 'top'",
			'\tcursor?: string | null',
			'}',
		].join('\n'),
	)
})

test('non-schema typeof consts fall back to their declaration source', () => {
	const exportDetail = projectExport({
		'src/index.ts': `const modes = ['draft', 'publish'] as const

export function run(mode: (typeof modes)[number]): string {
	return mode
}
`,
	})
	expect(exportDetail?.referencedTypes).toEqual([
		{
			name: 'modes',
			kind: 'const',
			definition: "const modes = ['draft', 'publish'] as const",
		},
	])
})

test('plain interfaces and type literals project unchanged', () => {
	const exportDetail = projectExport({
		'src/index.ts': `interface Target {
	owner: string
}

type Input = { target: Target; dryRun?: boolean }

export function launch(input: Input): void {}
`,
	})
	expect(exportDetail?.referencedTypes).toEqual([
		{
			name: 'Input',
			kind: 'type',
			definition: 'type Input = { target: Target; dryRun?: boolean }',
		},
		{
			name: 'Target',
			kind: 'interface',
			definition: 'interface Target {\n\towner: string\n}',
		},
	])
})

test('recursive and huge schemas stay bounded', () => {
	const hugeFields = Array.from(
		{ length: 2_000 },
		(_, index) => `\tfield${index}: optional(string()),`,
	).join('\n')
	const exportDetail = projectExport({
		'src/index.ts': `import { array, lazy, object, optional, string } from 'remix/data-schema'

const NodeSchema = object({
	name: string(),
	children: array(NodeSchema),
	next: lazy(() => NodeSchema),
})

const HugeSchema = object({
${hugeFields}
})

type Infer<S> = S

export function walk(node: Infer<typeof NodeSchema>, huge: Infer<typeof HugeSchema>): void {}
`,
	})
	expect(definitionOf(exportDetail, 'NodeSchema')).toBe(
		[
			'// typeof NodeSchema resolves to this schema input:',
			'{',
			'\tname: string',
			'\tchildren: Array<unknown /* recursive: NodeSchema */>',
			'\tnext: unknown /* recursive: NodeSchema */',
			'}',
		].join('\n'),
	)
	const huge = definitionOf(exportDetail, 'HugeSchema') ?? ''
	expect(huge.length).toBeLessThanOrEqual(4_100)
	expect(huge).toContain('field0?: string')
	expect(huge).toContain('// … 1800 more field(s)')
	const totalChars = (exportDetail?.referencedTypes ?? []).reduce(
		(sum, type) => sum + type.definition.length,
		0,
	)
	expect(totalChars).toBeLessThanOrEqual(12_000)
})

test('fields resolve schema consts imported across package files', () => {
	const exportDetail = projectExport({
		'src/strings.ts': `import { string } from 'remix/data-schema'

export const trimmedString = string()
`,
		'src/shared.ts': `export { trimmedString as text } from './strings.ts'
`,
		'src/repeat.ts': `import { enum_, number, object, optional } from 'remix/data-schema'

const frequencies = ['daily', 'weekly'] as const

export const RepeatSpecSchema = object({
	frequency: enum_(frequencies),
	interval: optional(number()),
})
`,
		'src/index.ts': `import { enum_, object, optional, type InferInput } from 'remix/data-schema'
import { opaqueSchema } from 'some-schema-lib'
import { RepeatSpecSchema } from './repeat.ts'
import { text } from './shared.ts'
import { trimmedString } from './strings.ts'
import { MissingSchema } from './missing.ts'

export const CreateEventInputSchema = object(
	{
		summary: trimmedString,
		location: optional(text),
		repeat: optional(RepeatSpecSchema),
		sendUpdates: optional(enum_(['all', 'externalOnly', 'none'] as const)),
		visibility: enum_(['public', 'private']),
		extra: optional(opaqueSchema),
		missing: MissingSchema,
	},
	{ unknownKeys: 'error' },
)

export type CreateEventParams = InferInput<typeof CreateEventInputSchema>

export default async function createEvent(raw: CreateEventParams) {
	return raw
}
`,
	})
	const definition = definitionOf(exportDetail, 'CreateEventInputSchema')
	expect(definition).toBe(
		[
			'// typeof CreateEventInputSchema resolves to this schema input (unknown keys rejected):',
			'{',
			'\tsummary: string',
			'\tlocation?: string',
			'\trepeat?: {',
			"\t\tfrequency: 'daily' | 'weekly'",
			'\t\tinterval?: number',
			'\t}',
			"\tsendUpdates?: 'all' | 'externalOnly' | 'none'",
			"\tvisibility: 'public' | 'private'",
			'\textra?: unknown /* opaqueSchema */',
			'\tmissing: unknown /* MissingSchema */',
			'}',
		].join('\n'),
	)
	expect(definition).not.toContain('typeof trimmedString')
})
