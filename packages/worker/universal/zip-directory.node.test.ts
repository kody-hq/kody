import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { zipDirectory } from './zip-directory.ts'
function fixture() {
	return new Uint8Array(
		readFileSync(
			new URL('../../../e2e/fixtures/files/launch.xlsx', import.meta.url),
		),
	).buffer
}
test('Office archive metadata can be read without extracting bodies', () => {
	const entries = zipDirectory(fixture())
	expect(entries.some((entry) => entry.name === 'xl/workbook.xml')).toBe(true)
	expect(
		entries.every((entry) => entry.bytes >= 0 && entry.compressedBytes >= 0),
	).toBe(true)
})
test('archive validation rejects truncated, ZIP64, and oversized directory entries', () => {
	expect(() => zipDirectory(new ArrayBuffer(10))).toThrow('Invalid ZIP')
	const huge = fixture(),
		view = new DataView(huge)
	const end = huge.byteLength - 22,
		start = view.getUint32(end + 16, true)
	view.setUint32(start + 24, 65 * 1024 * 1024, true)
	expect(() => zipDirectory(huge)).toThrow('preview limits')
	const zip64 = fixture()
	new DataView(zip64).setUint16(zip64.byteLength - 12, 65535, true)
	expect(() => zipDirectory(zip64)).toThrow('not supported')
})
