import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
	packageIdMatchesLocalPackage,
	resolveLocalPackageBinding,
} from '../src/local-package-run.js'

test('packageIdMatchesLocalPackage requires exact scoped name when known', () => {
	assert.equal(
		packageIdMatchesLocalPackage({
			specifier: 'kody:@someone/pkg/export',
			kodyId: 'pkg',
			packageName: '@someone/pkg',
		}),
		true,
	)
	assert.equal(
		packageIdMatchesLocalPackage({
			specifier: 'kody:@other/pkg/export',
			kodyId: 'pkg',
			packageName: '@someone/pkg',
		}),
		false,
	)
})

test('packageIdMatchesLocalPackage without packageName only matches exact package name or bare kody id', () => {
	assert.equal(
		packageIdMatchesLocalPackage({
			specifier: 'kody:pkg/export',
			kodyId: 'pkg',
		}),
		true,
	)
	assert.equal(
		packageIdMatchesLocalPackage({
			specifier: 'kody:@someone/pkg/export',
			kodyId: 'pkg',
		}),
		false,
	)
	assert.equal(
		packageIdMatchesLocalPackage({
			specifier: 'kody:@someone/pkg/export',
			kodyId: '@someone/pkg',
		}),
		true,
	)
})

test('resolveLocalPackageBinding ignores dependency bindings that share a leaf', async () => {
	const root = mkdtempSync(join(tmpdir(), 'kody-binding-match-'))
	try {
		mkdirSync(root, { recursive: true })
		writeFileSync(
			join(root, 'package.json'),
			JSON.stringify({
				name: '@someone/pkg',
				type: 'module',
				kody: { id: 'pkg' },
			}),
		)
		const bound = await resolveLocalPackageBinding({
			graph: {
				modules: [],
				imports: [],
				packageBindings: {
					'self-uuid': 'kpb1.self.sig',
					'dep-uuid': 'kpb1.dep.sig',
				},
				packageIdsByImport: {
					'kody:@someone/pkg/export': 'self-uuid',
					'kody:@other/pkg/util': 'dep-uuid',
				},
			},
			kodyId: 'pkg',
			packageRoot: root,
			apiUrl: 'https://api.kody.codes',
			token: 'kody_tok_test',
		})
		assert.deepEqual(bound, {
			packageId: 'self-uuid',
			packageBinding: 'kpb1.self.sig',
		})

		const onlyDep = await resolveLocalPackageBinding({
			graph: {
				modules: [],
				imports: [],
				packageBindings: { 'dep-uuid': 'kpb1.dep.sig' },
				packageIdsByImport: { 'kody:@other/pkg/util': 'dep-uuid' },
			},
			kodyId: 'pkg',
			packageRoot: root,
			apiUrl: 'https://api.kody.codes',
			token: 'kody_tok_test',
			listClient: {
				apiUrl: 'https://api.kody.codes',
				token: 'kody_tok_test',
				fetchFn: async () =>
					new Response(JSON.stringify({ packages: [] }), {
						status: 200,
						headers: { 'content-type': 'application/json' },
					}),
			},
		})
		assert.equal(onlyDep, null)
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})
