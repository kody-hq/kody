import { expect, test } from 'vitest'
import {
	acquireReceivePackGate,
	computeReceivePackBusyBackoffMs,
	readReceivePackBodyWithLimit,
	ReceivePackBodyTimeoutError,
	ReceivePackBodyTooLargeError,
	ReceivePackWaitTimeoutError,
	releaseReceivePackGate,
	scanReceivePackResultForBusy,
	sniffInBandReceivePackBusy,
	waitOutReceivePackBusy,
	withReceivePackGate,
} from './artifacts-receive-pack-wait.ts'

test('FIFO gate runs waiters in arrival order', async () => {
	const key = `fifo-${crypto.randomUUID()}`
	const order: Array<string> = []
	let releaseFirst!: () => void
	const firstHold = new Promise<void>((resolve) => {
		releaseFirst = resolve
	})

	const first = withReceivePackGate(key, 5_000, async () => {
		order.push('a-start')
		await firstHold
		order.push('a-end')
		return 'a'
	})
	// Ensure A holds before B/C enqueue.
	await Promise.resolve()
	const second = withReceivePackGate(key, 5_000, async () => {
		order.push('b')
		return 'b'
	})
	const third = withReceivePackGate(key, 5_000, async () => {
		order.push('c')
		return 'c'
	})

	releaseFirst()
	await expect(Promise.all([first, second, third])).resolves.toEqual([
		'a',
		'b',
		'c',
	])
	expect(order).toEqual(['a-start', 'a-end', 'b', 'c'])
})

test('FIFO gate times out waiters that never get a turn', async () => {
	const key = `timeout-${crypto.randomUUID()}`
	await acquireReceivePackGate(key, 1_000)
	try {
		await expect(acquireReceivePackGate(key, 20)).rejects.toBeInstanceOf(
			ReceivePackWaitTimeoutError,
		)
	} finally {
		releaseReceivePackGate(key)
	}
})

test('busy wait retries until a non-busy response', async () => {
	const sleeps: Array<number> = []
	let attempts = 0
	const result = await waitOutReceivePackBusy({
		deadlineMs: Date.now() + 10_000,
		backoffMs: [5, 5],
		random: () => 1,
		sleep: async (ms) => {
			sleeps.push(ms)
		},
		send: async () => {
			attempts += 1
			if (attempts < 3) {
				return new Response('remote: artifacts_git_receive_pack_busy\n', {
					status: 500,
				})
			}
			return new Response('000eunpack ok\n0000', { status: 200 })
		},
		isBusy: (response, bodyText) =>
			response.status >= 300 &&
			bodyText.includes('artifacts_git_receive_pack_busy'),
		readBusyBody: async (response) => response.text(),
	})
	expect(result.kind).toBe('response')
	if (result.kind === 'response') {
		expect(result.response.status).toBe(200)
		expect(await result.response.text()).toBe('000eunpack ok\n0000')
	}
	expect(attempts).toBe(3)
	expect(sleeps.length).toBe(2)
})

test('busy wait does not retry unrelated upstream errors', async () => {
	let attempts = 0
	const result = await waitOutReceivePackBusy({
		deadlineMs: Date.now() + 10_000,
		send: async () => {
			attempts += 1
			return new Response('internal blowup', { status: 500 })
		},
		isBusy: () => false,
		readBusyBody: async (response) => response.text(),
	})
	expect(attempts).toBe(1)
	expect(result.kind).toBe('response')
	if (result.kind === 'response') {
		expect(result.response.status).toBe(500)
		expect(await result.response.text()).toBe('internal blowup')
	}
})

function pktLine(payload: string | Uint8Array) {
	const bytes =
		typeof payload === 'string' ? new TextEncoder().encode(payload) : payload
	const header = new TextEncoder().encode(
		(bytes.length + 4).toString(16).padStart(4, '0'),
	)
	const merged = new Uint8Array(header.length + bytes.length)
	merged.set(header)
	merged.set(bytes, header.length)
	return merged
}

function sideband(band: number, text: string) {
	const body = new TextEncoder().encode(text)
	const payload = new Uint8Array(body.length + 1)
	payload[0] = band
	payload.set(body, 1)
	return pktLine(payload)
}

function concat(...parts: Array<Uint8Array>) {
	const total = parts.reduce((sum, part) => sum + part.length, 0)
	const merged = new Uint8Array(total)
	let offset = 0
	for (const part of parts) {
		merged.set(part, offset)
		offset += part.length
	}
	return merged
}

// Exact body observed from Artifacts in production for a contended push.
const inBandBusyBody = sideband(3, 'artifacts_git_receive_pack_busy\n')

function streamOf(bytes: Uint8Array, chunkSize: number) {
	let offset = 0
	return new ReadableStream<Uint8Array>({
		pull(controller) {
			if (offset >= bytes.length) {
				controller.close()
				return
			}
			controller.enqueue(bytes.slice(offset, offset + chunkSize))
			offset += chunkSize
		},
	})
}

test('pkt-line scan skips progress and ignores unrelated fatals and data', () => {
	expect(
		scanReceivePackResultForBusy(
			concat(sideband(2, 'Resolving deltas\n'), inBandBusyBody),
		),
	).toEqual({ kind: 'busy' })
	expect(
		scanReceivePackResultForBusy(
			pktLine('ERR artifacts_git_receive_pack_busy'),
		),
	).toEqual({ kind: 'busy' })
	expect(scanReceivePackResultForBusy(sideband(3, 'disk full\n'))).toEqual({
		kind: 'not-busy',
	})
	expect(
		scanReceivePackResultForBusy(
			sideband(1, 'artifacts_git_receive_pack_busy in a commit msg'),
		),
	).toEqual({ kind: 'not-busy' })
	expect(scanReceivePackResultForBusy(inBandBusyBody.subarray(0, 20))).toEqual({
		kind: 'need-more',
	})
	expect(
		scanReceivePackResultForBusy(new TextEncoder().encode('0000')),
	).toEqual({ kind: 'not-busy' })
})

test('busy wait retries HTTP 200 in-band busy results', async () => {
	const success = concat(
		sideband(2, 'progress\n'),
		sideband(1, '000eunpack ok\n0019ok refs/heads/main\n0000'),
		new TextEncoder().encode('0000'),
	)
	let attempts = 0
	const result = await waitOutReceivePackBusy({
		deadlineMs: Date.now() + 10_000,
		backoffMs: [1],
		sleep: async () => {},
		send: async () => {
			attempts += 1
			const body = attempts < 3 ? inBandBusyBody : success
			return new Response(streamOf(body, 7), {
				status: 200,
				headers: { 'Content-Type': 'application/x-git-receive-pack-result' },
			})
		},
		isBusy: () => false,
		readBusyBody: async () => {
			throw new Error('2xx bodies are sniffed, not read as error text')
		},
	})
	expect(attempts).toBe(3)
	expect(result.kind).toBe('response')
	if (result.kind === 'response') {
		expect(result.response.status).toBe(200)
		expect(result.response.headers.get('Content-Type')).toBe(
			'application/x-git-receive-pack-result',
		)
		expect(new Uint8Array(await result.response.arrayBuffer())).toEqual(success)
	}
})

test('in-band busy until the budget expires returns timeout', async () => {
	let now = 0
	const result = await waitOutReceivePackBusy({
		deadlineMs: 100,
		backoffMs: [60],
		random: () => 1,
		now: () => now,
		sleep: async (ms) => {
			now += ms
		},
		send: async () => new Response(inBandBusyBody, { status: 200 }),
		isBusy: () => false,
		readBusyBody: async (response) => response.text(),
	})
	expect(result).toEqual({ kind: 'timeout' })
})

test('sniff preserves large non-busy bodies byte for byte', async () => {
	const big = concat(
		sideband(1, 'x'.repeat(60_000)),
		sideband(1, 'y'.repeat(60_000)),
		new TextEncoder().encode('0000'),
	)
	const sniffed = await sniffInBandReceivePackBusy(
		new Response(streamOf(big, 4096), { status: 200 }),
	)
	expect(sniffed.busy).toBe(false)
	if (!sniffed.busy) {
		expect(new Uint8Array(await sniffed.response.arrayBuffer())).toEqual(big)
	}
})

test('a stalled 2xx result is passed through after the sniff timeout', async () => {
	let controller!: ReadableStreamDefaultController<Uint8Array>
	const stream = new ReadableStream<Uint8Array>({
		start(c) {
			controller = c
		},
	})
	const sniffed = await sniffInBandReceivePackBusy(
		new Response(stream, { status: 200 }),
		{ timeoutMs: 5 },
	)
	expect(sniffed.busy).toBe(false)
	const late = sideband(1, '000eunpack ok\n0000')
	controller.enqueue(late)
	controller.close()
	if (!sniffed.busy) {
		expect(new Uint8Array(await sniffed.response.arrayBuffer())).toEqual(late)
	}
})

test('busy attempts are aborted before the retry is sent', async () => {
	const signals: Array<AbortSignal> = []
	const result = await waitOutReceivePackBusy({
		deadlineMs: Date.now() + 10_000,
		backoffMs: [1],
		sleep: async () => {
			expect(signals.at(-1)?.aborted).toBe(true)
		},
		send: async (_attempt, signal) => {
			signals.push(signal)
			return signals.length < 3
				? new Response(inBandBusyBody, { status: 200 })
				: new Response('000eunpack ok\n0000', { status: 200 })
		},
		isBusy: () => false,
		readBusyBody: async (response) => response.text(),
	})
	expect(result.kind).toBe('response')
	expect(signals.map((signal) => signal.aborted)).toEqual([true, true, false])
})

test('full jitter backoff stays within the configured step', () => {
	expect(computeReceivePackBusyBackoffMs(0, [100], () => 0)).toBe(0)
	expect(computeReceivePackBusyBackoffMs(0, [100], () => 1)).toBe(100)
})

test('body reader enforces the buffer limit', async () => {
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new Uint8Array(100))
			controller.enqueue(new Uint8Array(100))
			controller.close()
		},
	})
	await expect(
		readReceivePackBodyWithLimit(stream, 150),
	).rejects.toBeInstanceOf(ReceivePackBodyTooLargeError)
})

test('withReceivePackGate releases after a thrown fn', async () => {
	const key = `release-${crypto.randomUUID()}`
	await expect(
		withReceivePackGate(key, 1_000, async () => {
			throw new Error('boom')
		}),
	).rejects.toThrow('boom')
	await expect(withReceivePackGate(key, 1_000, async () => 'ok')).resolves.toBe(
		'ok',
	)
})

test('readReceivePackBodyWithLimit times out a stalled upload', async () => {
	const stalled = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new Uint8Array([1, 2, 3]))
		},
	})
	await expect(
		readReceivePackBodyWithLimit(stalled, 1024, 20),
	).rejects.toBeInstanceOf(ReceivePackBodyTimeoutError)
})

test('waitOutReceivePackBusy does not send after the deadline', async () => {
	let sends = 0
	const result = await waitOutReceivePackBusy({
		deadlineMs: 0,
		now: () => 1,
		send: async () => {
			sends += 1
			return new Response('ok')
		},
		isBusy: () => true,
		readBusyBody: async () => '',
	})
	expect(result.kind).toBe('timeout')
	expect(sends).toBe(0)
})
