import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test } from 'vitest'
import {
	buildExecuteModuleBundle,
	type IsolatedExecuteBundleRequest,
} from './isolated-execute-bundle.ts'

const code = `import status from 'kody:@acme/factory/status'
export default async () => status()`

function createEnv() {
	const names: Array<string> = []
	const env = {
		REPO_SESSION: {
			idFromName(name: string) {
				names.push(name)
				return name
			},
			get() {
				return {
					async buildIsolatedExecuteBundle(
						input: IsolatedExecuteBundleRequest,
					) {
						return {
							ok: true,
							bundle: {
								mainModule: 'main.js',
								modules: { 'main.js': input.sourceFiles['main.ts'] ?? '' },
								dependencies: [],
							},
						}
					},
				}
			},
		},
	} as unknown as Env
	return { env, names }
}

function build(env: Env, input: { userId: string; code: string }) {
	return buildExecuteModuleBundle({
		env,
		baseUrl: 'https://heykody.dev',
		userId: ownerIdFromStored(input.userId),
		code: input.code,
		sourceFiles: { 'main.ts': input.code, 'package.json': '{}' },
		request: null,
	})
}

test('a repeated module builds on the same isolated instance, so its bundle cache can hit', async () => {
	const { env, names } = createEnv()

	await build(env, { userId: 'org-1', code })
	await build(env, { userId: 'org-1', code })
	await build(env, { userId: 'org-1', code: `${code}\n// changed` })
	await build(env, { userId: 'org-2', code })

	expect(names[0]).toBe(names[1])
	expect(new Set(names).size).toBe(3)
	expect(
		names.every((name) => name.startsWith('isolated-execute-bundle-')),
	).toBe(true)
})
