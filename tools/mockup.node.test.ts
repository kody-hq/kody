import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test } from 'vitest'
import {
	contactSheetHtml,
	mockupsDir,
	mockupVariants,
	parseMockupArgs,
	resolveMockupTarget,
} from './mockup.ts'

test('parses flags around the target', () => {
	expect(
		parseMockupArgs([
			'examples/not-found',
			'--states',
			'a,b',
			'--only',
			'dark-mobile',
			'--signed-in',
			'--keep-focus',
		]),
	).toEqual({
		target: 'examples/not-found',
		states: ['a', 'b'],
		variants: [mockupVariants[3]],
		signedIn: true,
		keepFocus: true,
	})
	expect(parseMockupArgs(['x']).variants).toEqual(mockupVariants)
})

test('rejects unknown variants, flags, and a missing target', () => {
	expect(() => parseMockupArgs(['x', '--only', 'sepia-desktop'])).toThrow(
		/Unknown --only sepia-desktop/,
	)
	expect(() => parseMockupArgs(['x', '--bogus'])).toThrow(/Unknown flag/)
	expect(() => parseMockupArgs(['x', '--states'])).toThrow(/needs a value/)
	expect(() => parseMockupArgs([])).toThrow(/usage/)
})

test('variants are 1440 desktop and 390 touch mobile at 2x', () => {
	expect(mockupVariants.map((v) => [v.id, v.viewport.width])).toEqual([
		['light-desktop', 1440],
		['dark-desktop', 1440],
		['light-mobile', 390],
		['dark-mobile', 390],
	])
	expect(
		mockupVariants.filter((v) => v.isMobile).map((v) => v.deviceScaleFactor),
	).toEqual([2, 2])
})

test('resolves names', () => {
	expect(resolveMockupTarget('examples/workspace-settings')).toEqual({
		name: 'examples/workspace-settings',
	})
	expect(() => resolveMockupTarget('examples/missing')).toThrow(
		/No mockup file/,
	)
})

test('copies outside files into local/', () => {
	const dir = mkdtempSync(path.join(tmpdir(), 'mockup-'))
	const file = path.join(dir, 'zz-test-copy.mockup.tsx')
	const copy = path.join(mockupsDir, 'local', 'zz-test-copy.mockup.tsx')
	writeFileSync(file, "export default { title: 'x', states: {} }\n")
	try {
		expect(resolveMockupTarget(file)).toEqual({ name: 'local/zz-test-copy' })
		expect(existsSync(copy)).toBe(true)
		expect(resolveMockupTarget(file)).toEqual({ name: 'local/zz-test-copy' })
	} finally {
		rmSync(dir, { recursive: true, force: true })
		rmSync(copy, { force: true })
	}
})

test('keeps a different local mockup with the same file name', () => {
	const dir = mkdtempSync(path.join(tmpdir(), 'mockup-'))
	const file = path.join(dir, 'zz-test-clash.mockup.tsx')
	const copy = path.join(mockupsDir, 'local', 'zz-test-clash.mockup.tsx')
	const local = "export default { title: 'local', states: {} }\n"
	mkdirSync(path.dirname(copy), { recursive: true })
	writeFileSync(copy, local)
	writeFileSync(file, "export default { title: 'outside', states: {} }\n")
	try {
		expect(() => resolveMockupTarget(file)).toThrow(/already exists/)
		expect(readFileSync(copy, 'utf8')).toBe(local)
	} finally {
		rmSync(dir, { recursive: true, force: true })
		rmSync(copy, { force: true })
	}
})

test('contact sheet labels each state and variant', () => {
	const html = contactSheetHtml({
		name: 'demo',
		shell: 'bare',
		states: ['open'],
		shots: [
			{
				state: 'open',
				variant: mockupVariants[2],
				file: 'x.png',
				dataUrl: 'data:,',
			},
		],
	})
	expect(html).toContain('<h2>open</h2>')
	expect(html).toContain('open · light mobile')
	expect(html).toContain('width:240px')
})
