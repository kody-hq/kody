import { test } from 'node:test'
import * as esbuild from 'esbuild'
import { createPackageAppEntrySource } from '../src/package-local-runtime-source.js'

test('the kody dev app entry is valid ESM', async () => {
	const source = createPackageAppEntrySource({ sideEffectModules: [] })
	await esbuild.transform(source, { loader: 'js', format: 'esm' })
})
