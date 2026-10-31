import { expect, test } from 'vitest'
import { parseAuthoredPackageJson } from './manifest.ts'
import {
	isPackageCapabilityDeclarationName,
	kodyPackageDependencyWildcard,
	listKodyPackageDependencyNames,
} from './types.ts'

function manifest(dependencies: unknown) {
	return JSON.stringify({
		name: '@scope/demo',
		exports: { '.': './index.ts' },
		kody: {
			id: 'demo',
			description: 'Demo package',
			dependencies,
		},
	})
}

test('kody.dependencies accepts a name-to-* map, rejects arrays, and lists names from either raw shape', () => {
	expect(listKodyPackageDependencyNames(undefined)).toEqual([])
	expect(
		listKodyPackageDependencyNames(['@scope/b', ' @scope/a ', '@scope/b']),
	).toEqual(['@scope/a', '@scope/b'])
	expect(listKodyPackageDependencyNames([1, '@scope/a', null])).toEqual([
		'@scope/a',
	])
	expect(
		listKodyPackageDependencyNames({
			'@scope/b': '*',
			'@scope/a': 'latest',
		}),
	).toEqual(['@scope/a', '@scope/b'])

	const fromMap = parseAuthoredPackageJson({
		content: manifest({
			'@scope/helper': '*',
			'@other/lib': '*',
		}),
	})
	expect(fromMap.kody.dependencies).toEqual({
		'@other/lib': kodyPackageDependencyWildcard,
		'@scope/helper': kodyPackageDependencyWildcard,
	})

	expect(() =>
		parseAuthoredPackageJson({
			content: manifest({ '@scope/helper': 'latest' }),
		}),
	).toThrow(/must be "\*"/)

	expect(() =>
		parseAuthoredPackageJson({
			content: manifest({ '@scope/helper': '^1.2.3' }),
		}),
	).toThrow(/must be "\*"/)

	expect(() =>
		parseAuthoredPackageJson({
			content: manifest({ helper: '*' }),
		}),
	).toThrow(/scoped package names/)

	expect(() =>
		parseAuthoredPackageJson({
			content: manifest(['@scope/helper', '@other/lib']),
		}),
	).toThrow(/must be a map/)

	expect(() =>
		parseAuthoredPackageJson({
			content: manifest([1, '@scope/helper']),
		}),
	).toThrow(/must be a map/)
})

function capabilitiesManifest(kody: Record<string, unknown>) {
	return JSON.stringify({
		name: '@scope/demo',
		exports: { '.': './index.ts' },
		kody: { id: 'demo', description: 'Demo package', ...kody },
	})
}

test('kody.capabilities and kody.app.capabilities accept MCP tools as mcp:<server>:<tool>', () => {
	const parsed = parseAuthoredPackageJson({
		content: capabilitiesManifest({
			capabilities: ['mcp:home:court_get_status'],
			app: {
				entry: 'src/app.ts',
				capabilities: [
					'secretList',
					' mcp:home:court_get_status ',
					'mcp:my-server-2:Tool_9_1a2b3c4d',
				],
			},
		}),
	})
	expect(parsed.kody.capabilities).toEqual(['mcp:home:court_get_status'])
	expect(parsed.kody.app?.capabilities).toEqual([
		'secretList',
		'mcp:home:court_get_status',
		'mcp:my-server-2:Tool_9_1a2b3c4d',
	])
})

test('malformed capability names are rejected with a message that says what to write', () => {
	const cases: Array<[string, RegExp]> = [
		['mcp:home:*', /wildcards are not supported/],
		['mcp:Home:court_get_status', /lowercase server name/],
		['mcp:home:court-get-status', /not a valid MCP tool capability/],
		['mcp:home:', /not a valid MCP tool capability/],
		['mcp::court_get_status', /not a valid MCP tool capability/],
		['mcp:home', /not a valid MCP tool capability/],
		['mcp:-home:tool', /not a valid MCP tool capability/],
		['mcp:home:tool:extra', /not a valid MCP tool capability/],
		['secret list', /use a Kody capability name like "secretList"/],
	]
	for (const [name, message] of cases) {
		expect(isPackageCapabilityDeclarationName(name)).toBe(false)
		for (const kody of [
			{ capabilities: [name] },
			{ app: { entry: 'src/app.ts', capabilities: [name] } },
		]) {
			expect(() =>
				parseAuthoredPackageJson({ content: capabilitiesManifest(kody) }),
			).toThrow(message)
		}
	}
	expect(isPackageCapabilityDeclarationName(`mcp:${'a'.repeat(64)}:tool`)).toBe(
		true,
	)
	expect(isPackageCapabilityDeclarationName(`mcp:${'a'.repeat(65)}:tool`)).toBe(
		false,
	)
	expect(
		isPackageCapabilityDeclarationName(`mcp:home:${'t'.repeat(137)}`),
	).toBe(true)
	expect(
		isPackageCapabilityDeclarationName(`mcp:home:${'t'.repeat(138)}`),
	).toBe(false)
})
