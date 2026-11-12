import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import { alwaysRemoteBindingKeys } from '../../../dev-runtime/src/local-config.ts'
import {
	kodyDevAllowlist,
	kodyDevBoundaryBridgeMethods,
	kodyDevBoundaryMocks,
} from '../../../dev-runtime/src/surface.ts'
import { packageAppSandboxBridgeMethods } from './package-app.ts'
import { kodyRuntimeSharedExportNames } from './runtime-source-modules.ts'

/**
 * Drift guard for `kody dev`. The mock target runs the hosted package runtime
 * on local workers, so every runtime export and bridge method is real unless it
 * is a named boundary mock. The working-tree bridge used by `--target prod`
 * must export the same names, and anything it nulls or refuses must be on the
 * allowlist with a docs entry.
 */
const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const read = (path: string) => readFileSync(`${repoRoot}${path}`, 'utf8')

function headingSlugs(markdown: string) {
	return new Set(
		[...markdown.matchAll(/^#{1,6} (.+)$/gm)].map(([, heading]) =>
			heading!
				.trim()
				.toLowerCase()
				.replace(/[^a-z0-9 -]/g, '')
				.replace(/ /g, '-'),
		),
	)
}

const legacyRuntimeSource = read(
	'packages/cli/src/package-local-runtime-source.ts',
)
const allowlistedExports = new Set(kodyDevAllowlist.flatMap((e) => e.exports))

test('only gap 8 stays on the allowlist', () => {
	expect(kodyDevAllowlist.map((entry) => entry.gap)).toEqual([8])
})

test('every allowlist and boundary mock entry links a docs heading', () => {
	const links = [
		...kodyDevAllowlist.map((entry) => entry.docs),
		...Object.values(kodyDevBoundaryMocks),
	]
	for (const link of links) {
		const [path, anchor] = link.split('#')
		expect(anchor, link).toBeTruthy()
		expect(headingSlugs(read(path!)), link).toContain(anchor)
	}
})

test('bindings dropped from the local stack are named boundary mocks', () => {
	for (const key of alwaysRemoteBindingKeys) {
		expect(Object.keys(kodyDevBoundaryMocks)).toContain(key)
	}
})

test('every bridge method runs real code or a named boundary mock', () => {
	const methods = new Set<string>(packageAppSandboxBridgeMethods)
	for (const method of Object.keys(kodyDevBoundaryBridgeMethods)) {
		expect(methods, `${method} is not a bridge method anymore`).toContain(
			method,
		)
	}
	expect(methods).toContain('appRateLimit')
	expect(methods).toContain('appSpendGet')
	expect(methods).toContain('appPublisherGet')
})

test('the working-tree bridge exports every hosted runtime export', () => {
	const exported = new Set(
		[
			...legacyRuntimeSource.matchAll(
				/^export (?:const|function|async function) (\w+)/gm,
			),
		].map(([, name]) => name),
	)
	for (const name of kodyRuntimeSharedExportNames) {
		expect(exported, `kody:runtime export ${name}`).toContain(name)
	}
})

test('nulled or refused working-tree exports are allowlisted', () => {
	const nulled = [
		...legacyRuntimeSource.matchAll(/^export const (\w+) = null;/gm),
	].map(([, name]) => name!)
	const refused = [
		...[
			...legacyRuntimeSource.matchAll(
				/^export function (\w+)\(\) \{\n\tthrow new Error/gm,
			),
		].map(([, name]) => name!),
		...[
			...legacyRuntimeSource.matchAll(/function __kody(\w+)Unavailable\(/g),
		].map(([, name]) => name!.charAt(0).toLowerCase() + name!.slice(1)),
	]
	for (const name of [...nulled, ...refused]) {
		expect(
			allowlistedExports,
			`${name} is null or refused in package-local-runtime-source.ts`,
		).toContain(name)
	}
	// Entries come off the allowlist as soon as the bridge serves them.
	expect([...allowlistedExports].sort()).toEqual([...nulled, ...refused].sort())
})
