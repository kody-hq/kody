import { expect, test } from 'vitest'
import { parseAuthoredPackageJson } from '#worker/package-registry/manifest.ts'
import {
	declaredCapabilitiesOf,
	effectivePackageAppCapabilities,
} from './package-app-effective-capabilities.ts'

function manifestOf(kody: Record<string, unknown>) {
	return parseAuthoredPackageJson({
		content: JSON.stringify({
			name: '@example/app',
			exports: { '.': './src/index.ts' },
			kody: { id: 'app', description: 'Example app', ...kody },
		}),
	})
}

const app = manifestOf({
	app: { entry: 'src/app.ts', capabilities: ['secretList'] },
})

test('an app with no imports may call only its own declarations', () => {
	expect(
		effectivePackageAppCapabilities({ manifest: app, dependencies: [] }),
	).toEqual(['secretList'])
})

test('an imported package brings its declared capabilities with it', () => {
	expect(
		effectivePackageAppCapabilities({
			manifest: app,
			dependencies: [
				{ capabilities: ['jobList', 'secretList'] },
				{ capabilities: ['emailSend'] },
			],
		}),
	).toEqual(['emailSend', 'jobList', 'secretList'])
})

test('a dependency recorded without declarations adds nothing', () => {
	const effective = effectivePackageAppCapabilities({
		manifest: app,
		dependencies: [{}, { capabilities: [] }],
	})
	expect(effective).toEqual(['secretList'])
	expect(effective).not.toContain('secretSet')
})

test('a non-app manifest grants nothing at runtime of its own', () => {
	const helper = manifestOf({ capabilities: ['secretSet'] })
	expect(declaredCapabilitiesOf(helper)).toEqual(['secretSet'])
	expect(
		effectivePackageAppCapabilities({ manifest: helper, dependencies: [] }),
	).toEqual([])
})

test('an app reads its declaration from kody.app.capabilities', () => {
	const both = manifestOf({
		capabilities: ['secretSet'],
		app: { entry: 'src/app.ts', capabilities: ['secretList'] },
	})
	expect(declaredCapabilitiesOf(both)).toEqual(['secretList'])
})
