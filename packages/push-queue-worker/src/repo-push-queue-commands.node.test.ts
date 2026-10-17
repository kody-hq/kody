import { expect, test } from 'vitest'
import {
	allReceivePackCommandsKnownStale,
	applyReportStatusToLandedRefs,
	buildStaleFetchFirstReportStatus,
	collectReportStatusOkRefs,
	encodeGitFlushPktBytes,
	encodeGitPktLineBytes,
	type LandedRefState,
	parseReceivePackCommands,
} from './repo-push-queue-commands.ts'

const oidA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const oidB = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const oidC = 'cccccccccccccccccccccccccccccccccccccccc'
const zeros = '0'.repeat(40)

function concat(...parts: Array<Uint8Array>) {
	const total = parts.reduce((sum, part) => sum + part.byteLength, 0)
	const out = new Uint8Array(total)
	let offset = 0
	for (const part of parts) {
		out.set(part, offset)
		offset += part.byteLength
	}
	return out
}

function receivePackBody(
	commands: Array<{ oldOid: string; newOid: string; ref: string }>,
	capabilities = 'report-status side-band-64k',
) {
	const packets: Array<Uint8Array> = []
	commands.forEach((command, index) => {
		const base = `${command.oldOid} ${command.newOid} ${command.ref}`
		const payload = index === 0 ? `${base}\0${capabilities}\n` : `${base}\n`
		packets.push(encodeGitPktLineBytes(payload))
	})
	packets.push(encodeGitFlushPktBytes())
	packets.push(new TextEncoder().encode('PACK'))
	return concat(...packets)
}

test('parseReceivePackCommands reads old/new/ref and side-band capability', () => {
	const parsed = parseReceivePackCommands(
		receivePackBody(
			[
				{ oldOid: oidA, newOid: oidB, ref: 'refs/heads/main' },
				{ oldOid: zeros, newOid: oidC, ref: 'refs/heads/feature' },
			],
			'report-status delete-refs side-band-64k',
		),
	)
	expect(parsed).toEqual({
		sideband: true,
		reportStatus: true,
		commands: [
			{ oldOid: oidA, newOid: oidB, ref: 'refs/heads/main' },
			{ oldOid: zeros, newOid: oidC, ref: 'refs/heads/feature' },
		],
	})
	expect(
		parseReceivePackCommands(
			receivePackBody(
				[{ oldOid: oidA, newOid: oidB, ref: 'refs/heads/main' }],
				'report-status',
			),
		)?.sideband,
	).toBe(false)
	expect(
		parseReceivePackCommands(
			receivePackBody(
				[{ oldOid: oidA, newOid: oidB, ref: 'refs/heads/main' }],
				'side-band-64k',
			),
		)?.reportStatus,
	).toBe(false)
})

test('allReceivePackCommandsKnownStale matches only the immediate previous tip', () => {
	const landed = new Map<string, LandedRefState>([
		['refs/heads/main', { tip: oidB, previous: oidA }],
	])
	expect(
		allReceivePackCommandsKnownStale(
			[{ oldOid: oidA, newOid: oidC, ref: 'refs/heads/main' }],
			landed,
		),
	).toBe(true)
	expect(
		allReceivePackCommandsKnownStale(
			[{ oldOid: oidB, newOid: oidC, ref: 'refs/heads/main' }],
			landed,
		),
	).toBe(false)
	// Outside writer / force-push rewind to a historical oid must fall through.
	expect(
		allReceivePackCommandsKnownStale(
			[{ oldOid: oidC, newOid: oidA, ref: 'refs/heads/main' }],
			landed,
		),
	).toBe(false)
	expect(
		allReceivePackCommandsKnownStale(
			[{ oldOid: oidA, newOid: oidC, ref: 'refs/heads/other' }],
			landed,
		),
	).toBe(false)
	expect(
		allReceivePackCommandsKnownStale(
			[
				{ oldOid: oidA, newOid: oidC, ref: 'refs/heads/main' },
				{ oldOid: oidA, newOid: oidC, ref: 'refs/heads/feature' },
			],
			landed,
		),
	).toBe(false)
	expect(
		allReceivePackCommandsKnownStale(
			[
				{ oldOid: oidA, newOid: oidC, ref: 'refs/heads/main' },
				{ oldOid: oidA, newOid: oidC, ref: 'refs/heads/feature' },
			],
			new Map([
				['refs/heads/main', { tip: oidB, previous: oidA }],
				['refs/heads/feature', { tip: oidB, previous: oidA }],
			]),
		),
	).toBe(true)
})

test('buildStaleFetchFirstReportStatus emits unpack ok and ng fetch first', () => {
	const plain = buildStaleFetchFirstReportStatus(
		[{ oldOid: oidA, newOid: oidB, ref: 'refs/heads/main' }],
		{ sideband: false },
	)
	expect(new TextDecoder().decode(plain)).toBe(
		'000eunpack ok\n0023ng refs/heads/main fetch first\n0000',
	)
	const wrapped = buildStaleFetchFirstReportStatus(
		[{ oldOid: oidA, newOid: oidB, ref: 'refs/heads/main' }],
		{ sideband: true },
	)
	const decoded = new TextDecoder().decode(wrapped)
	expect(decoded).toContain('\x01')
	expect(decoded).toContain('ng refs/heads/main fetch first\n')
	expect(decoded.endsWith('0000')).toBe(true)
	expect(collectReportStatusOkRefs(plain).size).toBe(0)
})

test('applyReportStatusToLandedRefs records command old-oid as previous and clears on ng', () => {
	const landed = new Map<string, LandedRefState>()
	const okBody = concat(
		encodeGitPktLineBytes('unpack ok\n'),
		encodeGitPktLineBytes('ok refs/heads/main\n'),
		encodeGitPktLineBytes('ng refs/heads/other non-fast-forward\n'),
		encodeGitFlushPktBytes(),
	)
	applyReportStatusToLandedRefs(
		landed,
		[
			{ oldOid: oidA, newOid: oidB, ref: 'refs/heads/main' },
			{ oldOid: oidA, newOid: oidC, ref: 'refs/heads/other' },
		],
		okBody,
	)
	expect(landed.get('refs/heads/main')).toEqual({
		tip: oidB,
		previous: oidA,
	})
	expect(landed.has('refs/heads/other')).toBe(false)

	// Catch-up after an outside tip: record the real previous (command.oldOid).
	applyReportStatusToLandedRefs(
		landed,
		[{ oldOid: oidC, newOid: oidA, ref: 'refs/heads/main' }],
		concat(
			encodeGitPktLineBytes('unpack ok\n'),
			encodeGitPktLineBytes('ok refs/heads/main\n'),
			encodeGitFlushPktBytes(),
		),
	)
	expect(landed.get('refs/heads/main')).toEqual({
		tip: oidA,
		previous: oidC,
	})

	applyReportStatusToLandedRefs(
		landed,
		[{ oldOid: oidA, newOid: oidB, ref: 'refs/heads/main' }],
		concat(
			encodeGitPktLineBytes('unpack ok\n'),
			encodeGitPktLineBytes('ng refs/heads/main fetch first\n'),
			encodeGitFlushPktBytes(),
		),
	)
	expect(landed.has('refs/heads/main')).toBe(false)

	landed.set('refs/heads/main', { tip: oidB, previous: oidA })
	applyReportStatusToLandedRefs(
		landed,
		[{ oldOid: oidB, newOid: zeros, ref: 'refs/heads/main' }],
		concat(
			encodeGitPktLineBytes('unpack ok\n'),
			encodeGitPktLineBytes('ok refs/heads/main\n'),
			encodeGitFlushPktBytes(),
		),
	)
	expect(landed.has('refs/heads/main')).toBe(false)
})

test('collectReportStatusOkRefs reads sideband-wrapped ok lines', () => {
	const inner = concat(
		encodeGitPktLineBytes('unpack ok\n'),
		encodeGitPktLineBytes('ok refs/heads/main\n'),
		encodeGitFlushPktBytes(),
	)
	const framed = new Uint8Array(1 + inner.byteLength)
	framed[0] = 1
	framed.set(inner, 1)
	const body = concat(encodeGitPktLineBytes(framed), encodeGitFlushPktBytes())
	expect([...collectReportStatusOkRefs(body)]).toEqual(['refs/heads/main'])
})
