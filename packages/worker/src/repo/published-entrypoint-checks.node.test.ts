import { expect, test } from 'vitest'
import { checkPublishedEntrypointsForRebuild } from './published-entrypoint-checks.ts'

test('a published entrypoint with a narrowly typed required param passes (no typecheck at invocation)', () => {
	expect(
		checkPublishedEntrypointsForRebuild({
			sourceFiles: {
				'src/index.ts':
					'export default async function main(params: { name: string }) { return params.name }',
			},
			entryPoints: [{ path: 'src/index.ts' }],
		}),
	).toEqual({ ok: true })
})

test('even source with type errors passes; publish owns type checking', () => {
	expect(
		checkPublishedEntrypointsForRebuild({
			sourceFiles: {
				'src/index.ts': 'const n: number = "nope"\nexport default () => n',
			},
			entryPoints: [{ path: './src/index.ts' }],
		}),
	).toEqual({ ok: true })
})

test('a missing entrypoint or default export is reported clearly', () => {
	expect(
		checkPublishedEntrypointsForRebuild({
			sourceFiles: {},
			entryPoints: [{ path: 'src/gone.ts' }],
		}),
	).toEqual({
		ok: false,
		message:
			'Package runtime entrypoint(s) are missing from the published source snapshot: "src/gone.ts". Republish the package to restore them.',
	})
	const noDefault = checkPublishedEntrypointsForRebuild({
		sourceFiles: { 'src/lib.ts': 'export const value = 1' },
		entryPoints: [{ path: 'src/lib.ts' }],
	})
	expect(noDefault.ok).toBe(false)
	expect(noDefault.ok ? '' : noDefault.message).toContain(
		'Missing default export in: "src/lib.ts".',
	)
})
