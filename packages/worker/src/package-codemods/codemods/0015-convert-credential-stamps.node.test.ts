import { expect, test } from 'vitest'
import { credentialStampConvertMessages } from '#worker/credentials/credential-stamp-convert.ts'
import { convertCredentialStampsCodemod } from './0015-convert-credential-stamps.ts'

const packageContext = { packageName: '@acme/demo' }

function manifest(kody: Record<string, unknown> = {}) {
	return `${JSON.stringify(
		{
			name: '@acme/demo',
			exports: { '.': './index.ts' },
			kody: { description: 'Demo package.', ...kody },
		},
		null,
		'\t',
	)}\n`
}

test('0015 leaves |scope=package alone and does not rewrite', () => {
	const files = {
		'package.json': manifest(),
		'index.ts':
			"export const h = { Authorization: 'Bearer {{secret:TOKEN|scope=package}}' }",
	}
	const result = convertCredentialStampsCodemod.transform(files, packageContext)
	expect(result.changed).toBe(false)
	expect(result.files).toEqual(files)
	expect(result.needsManual[0]?.message).toBe(
		credentialStampConvertMessages.unconvertible,
	)
})

test('0015 seals literal credential() and declares side-effect remix', () => {
	const result = convertCredentialStampsCodemod.transform(
		{
			'package.json': manifest(),
			'index.ts': [
				"import 'remix/setup'",
				"import { credential } from 'kody:runtime'",
				'export default async function run() {',
				'\treturn credential("TOKEN")',
				'}',
			].join('\n'),
		},
		packageContext,
	)
	expect(result.changed).toBe(true)
	expect(result.needsManual).toEqual([])
	const parsed = JSON.parse(result.files['package.json']!)
	expect(parsed.dependencies.remix).toBe('3.0.0')
	expect(parsed.kody.credentials.TOKEN.description).toMatch(/TOKEN/)
})

test('0015 skips holdouts', () => {
	const files = {
		'package.json': manifest(),
		'index.ts':
			"export const h = { Authorization: 'Bearer {{secret:TOKEN|scope=package}}' }",
	}
	const result = convertCredentialStampsCodemod.transform(files, {
		packageName: '@kentcdodds/oauth-integration-health',
	})
	expect(result.changed).toBe(false)
	expect(result.needsManual).toEqual([
		{ path: null, message: credentialStampConvertMessages.holdout },
	])
	expect(result.files).toEqual(files)
})

test('0015 skips unconvertible computed names', () => {
	const result = convertCredentialStampsCodemod.transform(
		{
			'package.json': manifest(),
			'index.ts': [
				"import { credential } from 'kody:runtime'",
				'export default async function run(key: string) {',
				'\treturn credential(key)',
				'}',
			].join('\n'),
		},
		packageContext,
	)
	expect(result.changed).toBe(false)
	expect(result.needsManual[0]?.message).toBe(
		credentialStampConvertMessages.unconvertible,
	)
})

test('0015 nested manifest remap does not clobber sealed package.json', () => {
	const nestedManifest = `${JSON.stringify(
		{
			name: '@acme/nested',
			exports: { '.': './index.ts' },
			kody: { description: 'Nested package.' },
		},
		null,
		'\t',
	)}\n`
	const index = [
		"import { credential } from 'kody:runtime'",
		'export default async function run() {',
		'\treturn credential("TOKEN")',
		'}',
	].join('\n')
	const files = {
		'packages/nested/package.json': nestedManifest,
		'packages/nested/index.ts': index,
		'unrelated.txt': 'keep',
	}
	const result = convertCredentialStampsCodemod.transform(files, {
		packageName: '@acme/nested',
		manifestPath: 'packages/nested/package.json',
		sourceRoot: 'packages/nested',
	})
	expect(result.changed).toBe(true)
	expect(result.files['unrelated.txt']).toBe('keep')
	expect(result.files['packages/nested/package.json']).not.toBe(nestedManifest)
	const slots = JSON.parse(result.files['packages/nested/package.json']!).kody
		.credentials
	expect(slots.TOKEN.description).toMatch(/TOKEN/)
	// Root package.json must not appear from the package-relative alias.
	expect(result.files['package.json']).toBeUndefined()
})

test('0015 aliased nested manifest write does not restore stale copy', () => {
	// locatePackage without sourceRoot aliases package.json while leaving the
	// nested key in the convert map — remapping every key would clobber.
	const nestedManifest = `${JSON.stringify(
		{
			name: '@acme/nested',
			exports: { '.': './packages/nested/index.ts' },
			kody: { description: 'Nested package.' },
		},
		null,
		'\t',
	)}\n`
	const files = {
		'packages/nested/package.json': nestedManifest,
		'packages/nested/index.ts': [
			"import { credential } from 'kody:runtime'",
			'export default async function run() {',
			'\treturn credential("TOKEN")',
			'}',
		].join('\n'),
	}
	const result = convertCredentialStampsCodemod.transform(files, {
		packageName: '@acme/nested',
		manifestPath: 'packages/nested/package.json',
	})
	expect(result.changed).toBe(true)
	const sealed = result.files['packages/nested/package.json']!
	expect(sealed).not.toBe(nestedManifest)
	expect(JSON.parse(sealed).kody.credentials.TOKEN.description).toMatch(/TOKEN/)
})
