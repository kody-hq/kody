import { expect, test } from 'vitest'
import { parseAuthoredPackageJson } from '#worker/package-registry/manifest.ts'
import { collectPublishedPackageArtifactTargets } from './package-artifact-targets.ts'

function parseManifest(app: Record<string, string> | undefined) {
	return parseAuthoredPackageJson({
		content: JSON.stringify({
			name: '@kentcdodds/demo-app',
			exports: { '.': './src/index.ts' },
			kody: {
				id: 'demo-app',
				description: 'Demo app',
				app,
			},
		}),
	})
}

test('kody.app.client adds an app-client target next to the Worker app target', () => {
	const targets = collectPublishedPackageArtifactTargets(
		parseManifest({
			entry: './src/app.ts',
			client: './src/client.tsx',
			assets: './public',
		}),
	)

	expect(targets).toEqual([
		{ kind: 'app', entryPoint: 'src/app.ts', bundleKind: 'app' },
		{
			kind: 'app-client',
			entryPoint: 'src/client.tsx',
			bundleKind: 'app-client',
		},
		{
			kind: 'module',
			artifactName: '.',
			entryPoint: 'src/index.ts',
			bundleKind: 'module',
		},
		{
			kind: 'importable-module',
			artifactName: '.',
			entryPoint: 'src/index.ts',
			bundleKind: 'importable-module',
		},
	])
})

test('export artifact names are normalized so bare keys match import lookups', () => {
	const targets = collectPublishedPackageArtifactTargets(
		parseAuthoredPackageJson({
			content: JSON.stringify({
				name: '@kody/agent-mail',
				exports: {
					'.': './src/index.ts',
					'add-rule': './src/add-rule.ts',
					'./create-webhook': './src/create-webhook.ts',
				},
				kody: {
					id: 'agent-mail',
					description: 'AgentMail helpers',
				},
			}),
		}),
	)
	expect(
		targets
			.filter((target) => target.kind === 'importable-module')
			.map((target) => target.artifactName),
	).toEqual(['.', './add-rule', './create-webhook'])
})
