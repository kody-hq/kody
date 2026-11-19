import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import { parseAuthoredPackageJson } from './manifest.ts'

function manifestWithMachine(machine: unknown) {
	return JSON.stringify({
		name: '@acme/demo',
		exports: { '.': './index.ts' },
		kody: { description: 'Demo package.', machine },
	})
}

function publishError(machine: unknown) {
	try {
		parseAuthoredPackageJson({ content: manifestWithMachine(machine) })
	} catch (error) {
		return error instanceof Error ? error.message : String(error)
	}
	throw new Error('Expected publish to reject the manifest.')
}

test('the kody.machine example in docs/use/packages.md publishes', () => {
	const doc = readFileSync(
		join(
			dirname(fileURLToPath(import.meta.url)),
			'../../../../docs/use/packages.md',
		),
		'utf8',
	)
	const section = doc.split('### Machine access (`kody.machine`)')[1]
	const example = section?.match(/```json\n([\s\S]*?)```/)?.[1]
	expect(example).toContain('"kdocker"')
	expect(example).toContain('192.168.1.10')
	expect(parseAuthoredPackageJson({ content: example! }).kody.machine).toEqual({
		kdocker: {
			kind: 'command',
			description: 'Restart and inspect containers on the NAS',
		},
		nas: {
			kind: 'lan',
			description: 'Call the Synology API',
			hosts: ['192.168.1.10'],
			ports: [5001],
		},
		runner: { kind: 'fs', mode: 'rw', description: 'Write build output' },
	})
})

test('publish refuses kody.machine entries a machine could never match', () => {
	expect(
		publishError({ Kdocker: { kind: 'command', description: 'x' } }),
	).toMatch(/kody\.machine key "Kdocker" must be the entry's name/)
	expect(publishError({ sh: { kind: 'shell', description: 'x' } })).toMatch(
		/kind/,
	)
	expect(publishError({ kdocker: { kind: 'command' } })).toMatch(/description/)
	// Host names never match on a machine, so a need cannot ask for one.
	expect(
		publishError({
			nas: { kind: 'lan', description: 'x', hosts: ['nas.local'] },
		}),
	).toMatch(/hosts/)
	expect(
		publishError({ nas: { kind: 'lan', description: 'x', ports: [70000] } }),
	).toMatch(/ports/)
	expect(publishError({ runner: { kind: 'fs', description: 'x' } })).toMatch(
		/mode/,
	)
	expect(
		publishError({
			kdocker: { kind: 'command', description: 'x', executable: '/bin/sh' },
		}),
	).toMatch(/executable/)
	expect(
		publishError(
			Object.fromEntries(
				Array.from({ length: 21 }, (_, index) => [
					`c${index}`,
					{ kind: 'command', description: 'x' },
				]),
			),
		),
	).toMatch(/at most 20 entries/)
	expect(
		parseAuthoredPackageJson({
			content: manifestWithMachine({
				lan6: {
					kind: 'lan',
					description: 'x',
					hosts: ['10.0.0.0/8', 'fd00::/8', '::1'],
				},
			}),
		}).kody.machine,
	).toEqual({
		lan6: {
			kind: 'lan',
			description: 'x',
			hosts: ['10.0.0.0/8', 'fd00::/8', '::1'],
		},
	})
})

test('a published snapshot with a kody.machine value from before the key existed loads as undeclared', () => {
	for (const machine of ['nas', { Kdocker: { kind: 'command' } }]) {
		const manifest = parseAuthoredPackageJson({
			content: manifestWithMachine(machine),
			mode: 'published',
		})
		expect(manifest.kody.machine).toBeUndefined()
	}
	expect(
		parseAuthoredPackageJson({
			content: manifestWithMachine({
				kdocker: { kind: 'command', description: 'x' },
			}),
			mode: 'published',
		}).kody.machine,
	).toEqual({ kdocker: { kind: 'command', description: 'x' } })
})

test('one name can declare a list with one entry per kind, since a machine may reuse a name across kinds', () => {
	const lan = { kind: 'lan', description: 'Call the NAS' }
	const fs = { kind: 'fs', mode: 'ro', description: 'Read the NAS share' }
	expect(
		parseAuthoredPackageJson({
			content: manifestWithMachine({ nas: [lan, fs] }),
		}).kody.machine,
	).toEqual({
		nas: [
			{ kind: 'lan', description: 'Call the NAS' },
			{ kind: 'fs', mode: 'ro', description: 'Read the NAS share' },
		],
	})
	expect(publishError({ nas: [lan, lan] })).toContain('one entry per kind')
	expect(publishError({ nas: [] })).toContain('kody.machine')
	const many = Object.fromEntries(
		Array.from({ length: 11 }, (_, index) => [`nas${index}`, [lan, fs]]),
	)
	expect(publishError(many)).toContain('at most 20')
})
