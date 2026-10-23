import { expect, test } from 'vitest'
import { stripWorkerProcessEnvTypes } from './strip-worker-process-env-types.ts'

test('removes only the NodeJS.ProcessEnv augmentation from wrangler types', () => {
	const source = [
		'declare namespace Cloudflare {',
		'\tinterface Env {}',
		'}',
		'type StringifyValues<EnvType extends Record<string, unknown>> = {};',
		'declare namespace NodeJS {',
		'\tinterface ProcessEnv extends StringifyValues<Pick<Cloudflare.Env, "COOKIE_SECRET">> {}',
		'}',
		'declare module "*.md" {',
		'\tconst value: string;',
		'}',
		'',
	].join('\n')

	const stripped = stripWorkerProcessEnvTypes(source)

	expect(stripped).not.toContain('namespace NodeJS')
	expect(stripped).toContain('declare namespace Cloudflare {')
	expect(stripped).toContain('declare module "*.md" {')
	expect(stripWorkerProcessEnvTypes(stripped)).toBe(stripped)
})
