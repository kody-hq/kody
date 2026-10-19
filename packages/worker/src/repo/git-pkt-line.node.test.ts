import { expect, test } from 'vitest'
import {
	buildUploadPackAdvertisement,
	encodeGitFlushPkt,
	encodeGitPktLine,
	extractUploadPackWantOids,
	normalizeUploadPackNegotiationResponse,
	rewriteUploadPackAdvertisement,
	summarizeUploadPackRequest,
	uploadPackWantsOnlySnapshot,
} from './git-pkt-line.ts'

test('encodeGitPktLine prefixes the payload with a 4-byte hex length', () => {
	expect(encodeGitPktLine('# service=git-upload-pack\n')).toBe(
		'001e# service=git-upload-pack\n',
	)
	expect(encodeGitFlushPkt()).toBe('0000')
})

test('buildUploadPackAdvertisement advertises only the published snapshot on HEAD and the default branch', () => {
	const commit = '0123456789abcdef0123456789abcdef01234567'
	const body = new TextDecoder().decode(
		buildUploadPackAdvertisement({
			commit,
			defaultBranch: 'main',
			agent: 'kody-public-git',
		}),
	)
	expect(body.startsWith('001e# service=git-upload-pack\n0000')).toBe(true)
	expect(body).toContain(`${commit} HEAD\0`)
	expect(body).toContain(`symref=HEAD:refs/heads/main`)
	expect(body).toContain('allow-reachable-sha1-in-want')
	expect(body).toContain(`${commit} refs/heads/main\n`)
	expect(body.endsWith('0000')).toBe(true)
})

test('rewriteUploadPackAdvertisement keeps upstream capabilities and pins refs to the snapshot', () => {
	const live = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
	const published = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
	const upstream =
		encodeGitPktLine('# service=git-upload-pack\n') +
		encodeGitFlushPkt() +
		encodeGitPktLine(
			`${live} HEAD\0multi_ack thin-pack side-band-64k ofs-delta symref=HEAD:refs/heads/main agent=git/artifacts\n`,
		) +
		encodeGitPktLine(`${live} refs/heads/main\n`) +
		encodeGitPktLine(`${live} refs/heads/feature\n`) +
		encodeGitFlushPkt()

	const rewritten = new TextDecoder().decode(
		rewriteUploadPackAdvertisement({
			upstreamBody: new TextEncoder().encode(upstream),
			commit: published,
			defaultBranch: 'main',
			agent: 'kody-public-git',
		}),
	)

	expect(rewritten).toContain(`${published} HEAD\0`)
	expect(rewritten).toContain('multi_ack')
	expect(rewritten).toContain('thin-pack')
	expect(rewritten).toContain('side-band-64k')
	expect(rewritten).toContain('allow-reachable-sha1-in-want')
	expect(rewritten).toContain('allow-tip-sha1-in-want')
	expect(rewritten).toContain('agent=kody-public-git')
	expect(rewritten).toContain(`${published} refs/heads/main\n`)
	expect(rewritten).not.toContain(live)
	expect(rewritten).not.toContain('refs/heads/feature')
})

test('uploadPackWantsOnlySnapshot accepts the published oid and rejects others', () => {
	const published = '0123456789abcdef0123456789abcdef01234567'
	const other = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
	const allowed =
		encodeGitPktLine(
			`want ${published} multi_ack side-band-64k ofs-delta agent=git/2.45.0\n`,
		) +
		encodeGitPktLine('want ' + published + '\n') +
		encodeGitFlushPkt() +
		encodeGitPktLine('done\n')
	const rejected =
		encodeGitPktLine(`want ${other}\n`) +
		encodeGitFlushPkt() +
		encodeGitPktLine('done\n')

	expect(extractUploadPackWantOids(new TextEncoder().encode(allowed))).toEqual({
		ok: true,
		wants: [published, published],
	})
	expect(
		uploadPackWantsOnlySnapshot({
			body: new TextEncoder().encode(allowed),
			snapshotCommit: published,
		}),
	).toBe(true)
	expect(
		uploadPackWantsOnlySnapshot({
			body: new TextEncoder().encode(rejected),
			snapshotCommit: published,
		}),
	).toBe(false)
})

test('uploadPackWantsOnlySnapshot fails closed on empty wants, bad framing, and short oids', () => {
	const published = '0123456789abcdef0123456789abcdef01234567'
	const haveOnly =
		encodeGitFlushPkt() +
		encodeGitPktLine(`have ${published}\n`) +
		encodeGitPktLine('done\n')
	const shortWant =
		encodeGitPktLine('want deadbeef\n') +
		encodeGitFlushPkt() +
		encodeGitPktLine('done\n')
	// Length claims more bytes than remain — must not fail open.
	const truncated = new TextEncoder().encode('00ffwant ')
	// Multi-byte UTF-8 after a length that counted code units would desync a
	// string walker; byte framing still rejects trailing garbage.
	const trailingGarbage = new Uint8Array([
		...new TextEncoder().encode(encodeGitPktLine(`want ${published}\n`)),
		0xff,
		0xfe,
	])

	expect(
		uploadPackWantsOnlySnapshot({
			body: new TextEncoder().encode(haveOnly),
			snapshotCommit: published,
		}),
	).toBe(false)
	expect(
		uploadPackWantsOnlySnapshot({
			body: new TextEncoder().encode(shortWant),
			snapshotCommit: published,
		}),
	).toBe(false)
	expect(
		uploadPackWantsOnlySnapshot({
			body: truncated,
			snapshotCommit: published,
		}),
	).toBe(false)
	expect(
		uploadPackWantsOnlySnapshot({
			body: trailingGarbage,
			snapshotCommit: published,
		}),
	).toBe(false)
	expect(extractUploadPackWantOids(truncated)).toEqual({ ok: false })
})

const commonOid = '7708b8a3db843a5f7a69edd1117c2892fa8c6dd6'
const otherOid = '3239879e3239879e3239879e3239879e3239879e'

test('summarizeUploadPackRequest reads ack mode, done, and haves from the first want', () => {
	const detailed =
		encodeGitPktLine(
			`want ${otherOid} multi_ack_detailed no-done side-band-64k agent=git/2.47.3\n`,
		) +
		encodeGitFlushPkt() +
		encodeGitPktLine(`have ${commonOid}\n`) +
		encodeGitFlushPkt()
	expect(
		summarizeUploadPackRequest(new TextEncoder().encode(detailed)),
	).toEqual({ ackMode: 'detailed', hasDone: false, hasHaves: true })

	const multiWithDone =
		encodeGitPktLine(`want ${otherOid} multi_ack side-band-64k\n`) +
		encodeGitFlushPkt() +
		encodeGitPktLine('done\n')
	expect(
		summarizeUploadPackRequest(new TextEncoder().encode(multiWithDone)),
	).toEqual({ ackMode: 'multi', hasDone: true, hasHaves: false })

	const single =
		encodeGitPktLine(`want ${otherOid} side-band-64k\n`) +
		encodeGitFlushPkt() +
		encodeGitPktLine(`have ${commonOid}\n`) +
		encodeGitFlushPkt()
	expect(summarizeUploadPackRequest(new TextEncoder().encode(single))).toEqual({
		ackMode: 'single',
		hasDone: false,
		hasHaves: true,
	})
	expect(summarizeUploadPackRequest(new Uint8Array([0xff, 0xfe]))).toEqual({
		ackMode: 'single',
		hasDone: false,
		hasHaves: false,
	})
})

test('normalizeUploadPackNegotiationResponse rewrites plain ACKs and appends NAK', () => {
	const plain = new TextEncoder().encode(encodeGitPktLine(`ACK ${commonOid}\n`))
	const detailed = new TextDecoder().decode(
		normalizeUploadPackNegotiationResponse({
			body: plain,
			ackMode: 'detailed',
		}),
	)
	expect(detailed).toBe(
		encodeGitPktLine(`ACK ${commonOid} common\n`) + encodeGitPktLine('NAK\n'),
	)
	expect(detailed).not.toContain('ready')

	const multi = new TextDecoder().decode(
		normalizeUploadPackNegotiationResponse({ body: plain, ackMode: 'multi' }),
	)
	expect(multi).toBe(
		encodeGitPktLine(`ACK ${commonOid} continue\n`) + encodeGitPktLine('NAK\n'),
	)

	expect(
		new TextDecoder().decode(
			normalizeUploadPackNegotiationResponse({
				body: new Uint8Array(),
				ackMode: 'detailed',
			}),
		),
	).toBe(encodeGitPktLine('NAK\n'))
})

test('normalizeUploadPackNegotiationResponse leaves compliant and non-ack bodies unchanged', () => {
	const compliant =
		encodeGitPktLine(`ACK ${commonOid} common\n`) +
		encodeGitPktLine(`ACK ${commonOid} ready\n`) +
		encodeGitPktLine('NAK\n')
	const compliantBytes = new TextEncoder().encode(compliant)
	expect(
		new TextDecoder().decode(
			normalizeUploadPackNegotiationResponse({
				body: compliantBytes,
				ackMode: 'detailed',
			}),
		),
	).toBe(compliant)

	const sideband = new Uint8Array([
		...new TextEncoder().encode(encodeGitPktLine(`ACK ${commonOid}\n`)),
		0x30,
		0x30,
		0x30,
		0x39,
		0x01,
		0x50,
		0x41,
		0x43,
		0x4b,
		0x30,
		0x30,
		0x30,
		0x30,
	])
	const normalized = normalizeUploadPackNegotiationResponse({
		body: sideband,
		ackMode: 'detailed',
	})
	expect(Array.from(normalized)).toEqual(Array.from(sideband))

	const garbage = new Uint8Array([0x00, 0x01, 0x02])
	expect(
		Array.from(
			normalizeUploadPackNegotiationResponse({
				body: garbage,
				ackMode: 'multi',
			}),
		),
	).toEqual(Array.from(garbage))

	expect(
		Array.from(
			normalizeUploadPackNegotiationResponse({
				body: new TextEncoder().encode(encodeGitPktLine(`ACK ${commonOid}\n`)),
				ackMode: 'single',
			}),
		),
	).toEqual(
		Array.from(
			new TextEncoder().encode(encodeGitPktLine(`ACK ${commonOid}\n`)),
		),
	)
})
