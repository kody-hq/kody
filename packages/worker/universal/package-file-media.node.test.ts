import { expect, test } from 'vitest'
import {
	bytesToLatin1String,
	bytesToSnapshotString,
	classifyPackageFileMedia,
	latin1StringToBytes,
	looksLikeSvg,
	maxPackageFilePreviewBytes,
	resolvePackageFileRawType,
	safeContentDispositionFilename,
	shouldStoreArtifactBlobAsLatin1,
	sniffPackageFileMedia,
	snapshotStringToBytes,
} from './package-file-media.ts'

const pngBytes = Uint8Array.from([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0xd,
])
const pngLatin1 = bytesToLatin1String(pngBytes)
const jpegBytes = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46])
const jpegLatin1 = bytesToLatin1String(jpegBytes)

test('classifies allowlisted media, SVG safety, and non-preview binaries', () => {
	expect(
		classifyPackageFileMedia({ path: 'logo.png', content: pngLatin1 }),
	).toEqual({
		kind: 'image',
		contentType: 'image/png',
		byteLength: pngBytes.byteLength,
	})
	expect(
		classifyPackageFileMedia({ path: 'clip.mp4', content: 'ftypxxxx' }),
	).toMatchObject({ kind: 'video', contentType: 'video/mp4' })
	expect(
		classifyPackageFileMedia({ path: 'sound.mp3', content: 'ID3' }),
	).toMatchObject({ kind: 'audio', contentType: 'audio/mpeg' })

	expect(
		classifyPackageFileMedia({
			path: 'icon.svg',
			content: '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
		}),
	).toEqual({
		kind: 'image',
		contentType: 'image/svg+xml',
		byteLength: new TextEncoder().encode(
			'<svg xmlns="http://www.w3.org/2000/svg"></svg>',
		).byteLength,
	})
	expect(
		classifyPackageFileMedia({
			path: 'evil.svg',
			content: '<!DOCTYPE html><script>alert(1)</script>',
		}),
	).toBeNull()
	expect(looksLikeSvg('<script>alert(1)</script>')).toBe(false)
	expect(looksLikeSvg('<svg><script>alert(1)</script></svg>')).toBe(true)

	expect(
		classifyPackageFileMedia({ path: 'app.wasm', content: 'wasm\0' }),
	).toMatchObject({ kind: 'binary', contentType: null })
	expect(
		classifyPackageFileMedia({ path: 'mystery.bin', content: 'nope' }),
	).toMatchObject({ kind: 'binary' })
	expect(
		classifyPackageFileMedia({ path: 'notes.txt', content: 'ok\0nope' }),
	).toMatchObject({ kind: 'binary' })
	expect(
		classifyPackageFileMedia({ path: 'src/index.ts', content: 'export {}\n' }),
	).toBeNull()

	const oversized = 'x'.repeat(maxPackageFilePreviewBytes + 1)
	expect(
		classifyPackageFileMedia({ path: 'huge.png', content: oversized }),
	).toMatchObject({ kind: 'binary', contentType: null })
})

test('raw sniff requires allowlisted extension and matching magic', () => {
	expect(sniffPackageFileMedia({ path: 'logo.png', bytes: pngBytes })).toEqual({
		kind: 'image',
		contentType: 'image/png',
	})
	expect(
		sniffPackageFileMedia({
			path: 'logo.png',
			bytes: new TextEncoder().encode('<!DOCTYPE html><h1>nope</h1>'),
		}),
	).toBeNull()
	expect(
		sniffPackageFileMedia({
			path: 'page.html',
			bytes: pngBytes,
		}),
	).toBeNull()
	expect(
		sniffPackageFileMedia({ path: 'photo.jpg', bytes: jpegBytes }),
	).toEqual({
		kind: 'image',
		contentType: 'image/jpeg',
	})
	expect(
		sniffPackageFileMedia({
			path: 'icon.svg',
			bytes: new TextEncoder().encode(
				'<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>',
			),
		}),
	).toEqual({ kind: 'image', contentType: 'image/svg+xml' })
	expect(
		sniffPackageFileMedia({
			path: 'icon.svg',
			bytes: new TextEncoder().encode('<html><svg></svg></html>'),
		}),
	).toBeNull()
})

test('latin1 snapshot helpers recover binary bytes and skip SVG', () => {
	expect(shouldStoreArtifactBlobAsLatin1('logo.png')).toBe(true)
	expect(shouldStoreArtifactBlobAsLatin1('archive.zip')).toBe(true)
	expect(shouldStoreArtifactBlobAsLatin1('icon.svg')).toBe(false)
	expect(shouldStoreArtifactBlobAsLatin1('src/index.ts')).toBe(false)
	expect(snapshotStringToBytes(pngLatin1, 'logo.png')).toEqual(pngBytes)
	expect(latin1StringToBytes(jpegLatin1)).toEqual(jpegBytes)
	expect(bytesToSnapshotString(pngBytes, 'logo.png')).toBe(pngLatin1)
	expect(
		snapshotStringToBytes(
			bytesToSnapshotString(pngBytes, 'public/mark.png'),
			'public/mark.png',
		),
	).toEqual(pngBytes)
	// UTF-8 decoding replaces PNG's leading 0x89 with U+FFFD; latin1 of that
	// is 0xFD — the exact corruption `/_assets` used to serve.
	const utf8Corrupted = new TextDecoder().decode(pngBytes)
	expect(utf8Corrupted.charCodeAt(0)).toBe(0xfffd)
	expect(latin1StringToBytes(utf8Corrupted)[0]).toBe(0xfd)
	expect(safeContentDispositionFilename('docs/my"file\n.png')).toBe(
		'my_file_.png',
	)
})

test('raw type keeps sniffed media and serves everything else inert', () => {
	const encode = (value: string) => new TextEncoder().encode(value)
	expect(
		resolvePackageFileRawType({ path: 'logo.png', bytes: pngBytes }),
	).toEqual({ contentType: 'image/png', disposition: 'inline' })
	expect(
		resolvePackageFileRawType({
			path: 'icon.svg',
			bytes: encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>'),
		}),
	).toEqual({ contentType: 'image/svg+xml', disposition: 'inline' })
	const text = {
		contentType: 'text/plain; charset=utf-8',
		disposition: 'inline',
	}
	expect(
		resolvePackageFileRawType({
			path: 'src/skill-get.ts',
			bytes: encode('export {}\n'),
		}),
	).toEqual(text)
	expect(
		resolvePackageFileRawType({
			path: 'index.html',
			bytes: encode('<html><script>alert(1)</script></html>'),
		}),
	).toEqual(text)
	expect(
		resolvePackageFileRawType({
			path: 'evil.svg',
			bytes: encode('<html><script>alert(1)</script></html>'),
		}),
	).toEqual(text)
	const download = {
		contentType: 'application/octet-stream',
		disposition: 'attachment',
	}
	expect(
		resolvePackageFileRawType({ path: 'fake.png', bytes: encode('<html>') }),
	).toEqual(download)
	expect(
		resolvePackageFileRawType({ path: 'app.wasm', bytes: encode('asm') }),
	).toEqual(download)
	expect(
		resolvePackageFileRawType({
			path: 'data.txt',
			bytes: Uint8Array.from([104, 0, 105]),
		}),
	).toEqual(download)
	expect(
		resolvePackageFileRawType({
			path: 'data.unknown',
			bytes: Uint8Array.from([0xff, 0xfe, 0x41]),
		}),
	).toEqual(download)
	expect(
		resolvePackageFileRawType({
			path: 'notes.md',
			bytes: encode('héllo ✓\n'),
		}),
	).toEqual(text)
	expect(safeContentDispositionFilename('docs/résumé.md')).toBe('r_sum_.md')
})
