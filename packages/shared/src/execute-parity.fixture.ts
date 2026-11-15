/**
 * Execute modules that must behave the same on Kody cloud, in an execution
 * context, and under `execute --local`. Each runtime's tests run every case
 * and compare against the same expectation.
 */
export type ExecuteParityCase = {
	name: string
	code: string
	params?: Record<string, unknown>
	expected:
		| { result: unknown; logs?: Array<string> }
		| { errorIncludes: string }
}

export const executeParityCases: Array<ExecuteParityCase> = [
	{
		name: 'TypeScript annotations, types, and enums',
		code: [
			'type P = { n: number }',
			'enum Color { Red = 1 }',
			'export default async function main(params: P): Promise<{ doubled: number; color: number }> {',
			'\tconst n: number = (params?.n ?? 2) as number',
			'\treturn { doubled: n * 2, color: Color.Red }',
			'}',
		].join('\n'),
		params: { n: 21 },
		expected: { result: { doubled: 42, color: 1 } },
	},
	{
		name: 'TypeScript generics, satisfies, interfaces, and type-only imports',
		code: [
			"import type { Kody } from 'kody:runtime'",
			'interface Row { id: string }',
			'const pick = <T,>(items: Array<T>): T | undefined => items[0]',
			"const rows = [{ id: 'a' }, { id: 'b' }] satisfies Array<Row>",
			'let unused: Kody | undefined',
			'export default (): string => pick(rows)!.id + String(unused)',
		].join('\n'),
		expected: { result: 'aundefined' },
	},
	{
		name: 'plain JavaScript with top-level await',
		code: [
			'const base = await Promise.resolve(40)',
			'export default async (params) => base + params.add',
		].join('\n'),
		params: { add: 2 },
		expected: { result: 42 },
	},
	{
		name: 'params arrive as given',
		code: 'export default (params: Record<string, unknown>) => params',
		params: { nested: { list: [1, 'two', null] }, flag: true },
		expected: { result: { nested: { list: [1, 'two', null] }, flag: true } },
	},
	{
		name: 'console output is captured as logs',
		code: [
			'export default () => {',
			"\tconsole.log('hello', 1)",
			"\treturn 'done'",
			'}',
		].join('\n'),
		expected: { result: 'done', logs: ['hello 1'] },
	},
	{
		name: 'web platform globals',
		code: [
			'export default () => ({',
			'\tfetch: typeof fetch,',
			'\tcrypto: typeof crypto.subtle.digest,',
			'\turl: new URL("https://kody.codes/a?b=1").searchParams.get("b"),',
			'\tstructuredClone: typeof structuredClone,',
			'\ttextEncoder: new TextEncoder().encode("hi").length,',
			'\tsetTimeout: typeof setTimeout,',
			'\tatob: atob("aGk="),',
			'})',
		].join('\n'),
		expected: {
			result: {
				fetch: 'function',
				crypto: 'function',
				url: '1',
				structuredClone: 'function',
				textEncoder: 2,
				setTimeout: 'function',
				atob: 'hi',
			},
		},
	},
	{
		name: 'a thrown error fails the run with its message',
		code: [
			'export default (): never => {',
			"\tthrow new Error('parity boom')",
			'}',
		].join('\n'),
		expected: { errorIncludes: 'parity boom' },
	},
	{
		name: 'code that is not valid TypeScript fails to build',
		code: 'export default () => {\n\treturn (1 +\n}',
		expected: { errorIncludes: 'entry.ts:3:0' },
	},
]
