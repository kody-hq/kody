import { expect, test } from 'vitest'
import {
	sealCredentialStampsCodemod,
	sealCredentialStampsMessages,
} from './0014-seal-credential-stamps.ts'

const packageContext = { packageName: '@acme/demo' }

function manifest(kody: Record<string, unknown> = {}, indent = '\t') {
	return `${JSON.stringify(
		{
			name: '@acme/demo',
			exports: { '.': './index.ts' },
			kody: { description: 'Demo package.', ...kody },
		},
		null,
		indent,
	)}\n`
}

function transform(source: string, kody: Record<string, unknown> = {}) {
	return sealCredentialStampsCodemod.transform(
		{ 'package.json': manifest(kody), 'index.ts': source },
		packageContext,
	)
}

function declaredSlots(result: { files: Record<string, string> }) {
	return JSON.parse(result.files['package.json']!).kody.credentials as Record<
		string,
		{ description: string; kind?: string }
	>
}

test('0014 seals literal credential(), MCP servers, and OAuth accounts with inferred descriptions', () => {
	const result = transform(
		[
			"import { credential, createAuthenticatedFetch, kody } from 'kody:runtime'",
			'export default async function run() {',
			'\tconst gh = await credential("GITHUB")',
			"\tconst google = await createAuthenticatedFetch('google')",
			'\tawait kody.mcp.linear.list_issues({})',
			"\treturn google('https://www.googleapis.com/calendar/v3/users/me')",
			'}',
		].join('\n'),
	)
	expect(result.changed).toBe(true)
	expect(result.changedPaths).toEqual(['package.json'])
	expect(result.needsManual).toEqual([])
	expect(declaredSlots(result)).toEqual({
		GITHUB: {
			description: 'Used by this package as credential "GITHUB".',
		},
		google: {
			kind: 'oauth',
			description: 'OAuth access for google.',
		},
		linear: {
			kind: 'mcp',
			description: 'Calls tools on the attached MCP server "linear".',
		},
	})
})

test('0014 never overwrites an existing description', () => {
	const result = transform(
		[
			"import { credential } from 'kody:runtime'",
			'export default async function run() {',
			'\treturn credential("API_KEY")',
			'}',
		].join('\n'),
		{
			credentials: {
				API_KEY: { description: 'Owner-written API key description.' },
			},
		},
	)
	expect(result.changed).toBe(false)
	expect(result.needsManual).toEqual([])
	expect(declaredSlots(result).API_KEY).toEqual({
		description: 'Owner-written API key description.',
	})
})

test('0014 reports needs_manual for non-literal credential uses without changing files', () => {
	const result = transform(
		[
			"import { credential } from 'kody:runtime'",
			'export default async function run(key: string) {',
			'\treturn credential(key)',
			'}',
		].join('\n'),
	)
	expect(result.changed).toBe(false)
	expect(result.needsManual).toEqual([
		{
			path: 'index.ts',
			message: sealCredentialStampsMessages.unconvertible,
		},
	])
})

test('0014 seals a nested package against its own manifest path and source root', () => {
	const nestedManifest = `${JSON.stringify(
		{
			name: '@acme/nested',
			exports: { '.': './index.ts' },
			kody: { description: 'Nested package.' },
		},
		null,
		'\t',
	)}\n`
	const files = {
		'package.json': manifest(),
		'packages/nested/package.json': nestedManifest,
		'packages/nested/index.ts': [
			"import { credential } from 'kody:runtime'",
			'export default async function run() {',
			'\treturn credential("NESTED_KEY")',
			'}',
		].join('\n'),
	}
	const context = {
		packageName: '@acme/nested',
		manifestPath: 'packages/nested/package.json',
		sourceRoot: 'packages/nested',
	}
	const findings = sealCredentialStampsCodemod.detect(files, context)
	expect(findings).toEqual([
		{
			path: 'package.json',
			message: sealCredentialStampsMessages.declare,
		},
	])
	const result = sealCredentialStampsCodemod.transform(files, context)
	expect(result.changed).toBe(true)
	expect(result.changedPaths).toContain('packages/nested/package.json')
	const nestedSlots = JSON.parse(result.files['packages/nested/package.json']!)
		.kody.credentials as Record<string, { description: string } | undefined>
	expect(nestedSlots.NESTED_KEY?.description).toMatch(/NESTED_KEY/)
	const rootSlots = JSON.parse(result.files['package.json']!).kody
		.credentials as Record<string, unknown> | undefined
	expect(rootSlots).toBeUndefined()
})

test('0014 seals when the snapshot is already keyed from the nested source root', () => {
	const nestedManifest = `${JSON.stringify(
		{
			name: '@acme/nested',
			exports: { '.': './index.ts' },
			kody: { description: 'Nested package.' },
		},
		null,
		'\t',
	)}\n`
	const files = {
		'package.json': nestedManifest,
		'index.ts': [
			"import { credential } from 'kody:runtime'",
			'export default async function run() {',
			'\treturn credential("NESTED_KEY")',
			'}',
		].join('\n'),
	}
	const context = {
		packageName: '@acme/nested',
		manifestPath: 'packages/nested/package.json',
		sourceRoot: 'packages/nested',
	}
	const result = sealCredentialStampsCodemod.transform(files, context)
	expect(result.changed).toBe(true)
	expect(result.changedPaths).toEqual(['package.json'])
	expect(result.files['packages/nested/package.json']).toBeUndefined()
	const nestedSlots = JSON.parse(result.files['package.json']!).kody
		.credentials as Record<string, { description: string } | undefined>
	expect(nestedSlots.NESTED_KEY?.description).toMatch(/NESTED_KEY/)
})
