import { expect, test } from 'vitest'
import {
	fileAssetUrl,
	parseFileRange,
	inlineFileType,
	fileAssetPolicy,
} from './file-assets.ts'
import { fileViewerKind, detectFileMediaType } from './file-viewers.ts'
test('asset ranges cover full, open-ended, suffix, clipped, and invalid requests', () => {
	expect(parseFileRange(null, 100)).toBeNull()
	expect(parseFileRange('bytes=0-9', 100)).toEqual({ offset: 0, length: 10 })
	expect(parseFileRange('bytes=90-', 100)).toEqual({ offset: 90, length: 10 })
	expect(parseFileRange('bytes=-8', 100)).toEqual({ offset: 92, length: 8 })
	expect(parseFileRange('bytes=90-200', 100)).toEqual({
		offset: 90,
		length: 10,
	})
	for (const range of [
		'bytes=100-',
		'bytes=9-8',
		'bytes=-0',
		'bytes=0-1,4-5',
		'bytes=',
		'bytes=9007199254740992-',
	])
		expect(parseFileRange(range, 100)).toBe(false)
	expect(parseFileRange('bytes=0-', 0)).toBe(false)
})
test('only supported passive formats render inline', () => {
	for (const type of [
		'application/pdf',
		'image/svg+xml',
		'image/png',
		'audio/mpeg',
		'video/mp4',
	])
		expect(inlineFileType(type)).toBe(true)
	for (const type of [
		'text/html',
		'application/javascript',
		'application/octet-stream',
	])
		expect(inlineFileType(type)).toBe(false)
	expect(fileAssetUrl('team', 'file', 'revision', true)).toBe(
		'/file-assets/team/file?revision=revision&download=true',
	)
})
test('format detection keeps excluded formats out and recognizes browser MIME fallbacks', () => {
	expect(fileViewerKind('report.DOCX', 'application/octet-stream')).toBe('docx')
	expect(
		fileViewerKind(
			'workbook',
			'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
		),
	).toBe('xlsx')
	expect(fileViewerKind('slides.pptx', 'application/octet-stream')).toBe('pptx')
	expect(fileViewerKind('mark.svg', 'application/octet-stream')).toBe('image')
	expect(fileViewerKind('photo.png', 'application/octet-stream')).toBe('image')
	for (const name of ['diagram.mmd', 'model.stl', 'design.psd'])
		expect(fileViewerKind(name, 'application/octet-stream')).toBeNull()
	expect(fileViewerKind('archive.zip', 'application/octet-stream')).toBe('zip')
	expect(detectFileMediaType('unknown', '')).toBe('application/octet-stream')
})

test('PDF native styles do not enable scripts or weaken SVG isolation', () => {
	expect(fileAssetPolicy('application/pdf')).toContain(
		"style-src 'unsafe-inline'",
	)
	expect(fileAssetPolicy('application/pdf')).toContain("default-src 'none'")
	expect(fileAssetPolicy('application/pdf')).not.toContain('script-src')
	expect(fileAssetPolicy('image/svg+xml')).toContain('; sandbox')
	expect(fileAssetPolicy('image/svg+xml')).not.toContain('unsafe-inline')
})
