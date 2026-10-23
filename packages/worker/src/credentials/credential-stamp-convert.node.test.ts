import { expect, test } from 'vitest'
import {
	collectAllowlistedUndeclaredBareDeps,
	convertCredentialStampFiles,
} from './credential-stamp-convert.ts'

function manifest(
	kody: Record<string, unknown> = {},
	extra: Record<string, unknown> = {},
) {
	return `${JSON.stringify(
		{
			name: '@acme/demo',
			exports: { '.': './src/index.ts' },
			kody: { description: 'Demo package.', ...kody },
			...extra,
		},
		null,
		'\t',
	)}\n`
}

test('leaves |scope=package alone (would widen to session secrets)', () => {
	const files = {
		'package.json': manifest(),
		'src/index.ts':
			"export const h = { Authorization: 'Bearer {{secret:TOKEN|scope=package}}' }",
	}
	const result = convertCredentialStampFiles({
		packageName: '@acme/demo',
		files,
	})
	expect(result.skippedHoldout).toBe(false)
	expect(result.sealReady).toBe(false)
	expect(result.changed).toBe(false)
	expect(result.files).toEqual(files)
	expect(result.files['src/index.ts']).toContain('|scope=package')
	expect(result.needsManual).toHaveLength(1)
})

test('adds allowlisted undeclared remix then seals literal credentials', () => {
	const files = {
		'package.json': manifest(),
		'src/index.ts': [
			'import { Schema } from "remix/data-schema"',
			"import { credential } from 'kody:runtime'",
			'export default async function run() {',
			'\treturn credential("API_KEY")',
			'}',
		].join('\n'),
	}
	expect(collectAllowlistedUndeclaredBareDeps(files)).toEqual(['remix'])
	const result = convertCredentialStampFiles({
		packageName: '@acme/demo',
		files,
	})
	expect(result.sealReady).toBe(true)
	expect(result.changed).toBe(true)
	const parsed = JSON.parse(result.files['package.json']!)
	expect(parsed.dependencies.remix).toBe('3.0.0')
	expect(parsed.kody.credentials.API_KEY.description).toMatch(/API_KEY/)
})

test('collects side-effect bare imports for allowlisted deps', () => {
	const files = {
		'package.json': manifest(),
		'src/index.ts': [
			"import 'remix/setup'",
			"import { credential } from 'kody:runtime'",
			'export default async function run() {',
			'\treturn credential("API_KEY")',
			'}',
		].join('\n'),
	}
	expect(collectAllowlistedUndeclaredBareDeps(files)).toEqual(['remix'])
	const result = convertCredentialStampFiles({
		packageName: '@acme/demo',
		files,
	})
	expect(result.sealReady).toBe(true)
	expect(result.changed).toBe(true)
	const parsed = JSON.parse(result.files['package.json']!)
	expect(parsed.dependencies.remix).toBe('3.0.0')
})

test('skips Kent holdouts without changing files', () => {
	const files = {
		'package.json': manifest(),
		'src/index.ts':
			"export const h = { Authorization: 'Bearer {{secret:TOKEN|scope=package}}' }",
	}
	const result = convertCredentialStampFiles({
		packageName: '@kentcdodds/raycast',
		files,
	})
	expect(result.skippedHoldout).toBe(true)
	expect(result.changed).toBe(false)
	expect(result.files).toEqual(files)
	expect(result.needsManual).toHaveLength(1)
})

test('skips computed credential names without rewriting source', () => {
	const files = {
		'package.json': manifest(),
		'src/index.ts': [
			"import { credential } from 'kody:runtime'",
			'export default async function run(name: string) {',
			'\treturn credential(name)',
			'}',
		].join('\n'),
	}
	const result = convertCredentialStampFiles({
		packageName: '@acme/demo',
		files,
	})
	expect(result.sealReady).toBe(false)
	expect(result.changed).toBe(false)
	expect(result.files).toEqual(files)
	expect(result.needsManual).toHaveLength(1)
})

test('leaves |scope=user alone (would change which secret resolves)', () => {
	const files = {
		'package.json': manifest(),
		'src/index.ts':
			"export const h = { Authorization: 'Bearer {{secret:TOKEN|scope=user}}' }",
	}
	const result = convertCredentialStampFiles({
		packageName: '@acme/demo',
		files,
	})
	expect(result.sealReady).toBe(false)
	expect(result.changed).toBe(false)
	expect(result.files).toEqual(files)
})
