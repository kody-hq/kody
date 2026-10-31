/**
 * ECP v1 frame shapes and the signed frame codec. Every frame except the
 * fixed `{"t":"ping"}` keepalive is a signed envelope whose payload is
 * `{ v, t, ec, sid, seq, ts, re?, body }`. Validators are hand-written so
 * this module stays dependency free for other implementers and the CLI.
 */
import {
	ecpFrameSignaturePrefix,
	ecpPingFrame,
	parseEnvelope,
	signEnvelope,
	verifyEnvelope,
	type EcpEnvelope,
	type EcpCryptoKey,
} from './envelope.ts'
import { checkFrameClock, checkNextSeq } from './replay.ts'

export const ecpProtocolVersion = 1
export const ecpFrameFormatVersion = 1
export const ecpMaxFrameBytes = 6 * 1024 * 1024
export const ecpPingIntervalMs = 30_000
export const ecpPongTimeoutMs = 10_000
/** Dispatch only when the last liveness probe is newer than this. */
export const ecpLivenessFreshMs = 45_000
export const ecpDefaultAcceptWindowMs = 3_000
/** The context discards an uncommitted request this long after `acceptBy`. */
export const ecpCommitGraceMs = 2_000
/** Kody cancels a committed run this long after its deadline (`deadline`). */
export const ecpDeadlineCancelGraceMs = 5_000
export const ecpLostAfterDeadlineMs = 30_000
export const ecpMaxRunLogLines = 200
export const ecpMaxConcurrentRunsCap = 8
export const ecpMaxChainContexts = 3
export const ecpFramesPerSecond = 50

export const ecpServerFrameTypes = [
	'welcome',
	'run.request',
	'run.commit',
	'run.abort',
	'run.cancel',
	'run.result.ack',
	'grant.update',
	'revoke',
	'error',
] as const

export const ecpContextFrameTypes = [
	'hello',
	'status',
	'capabilities.update',
	'run.accept',
	'run.reject',
	'run.log',
	'run.result',
	'run.cancel.ack',
	'grant.ack',
	'command.finished',
	'error',
] as const

export type EcpServerFrameType = (typeof ecpServerFrameTypes)[number]
export type EcpContextFrameType = (typeof ecpContextFrameTypes)[number]

export const ecpRunRejectCodes = [
	'busy',
	'grant_mismatch',
	'capability_missing',
	'payload_too_large',
	'deadline_passed',
	'shutting_down',
	'version_unsupported',
] as const
export type EcpRunRejectCode = (typeof ecpRunRejectCodes)[number]

export const ecpCancelReasons = [
	'caller_cancelled',
	'deadline',
	'revoked',
	'grant_narrowed',
	'access_lost',
] as const
export type EcpCancelReason = (typeof ecpCancelReasons)[number]

export const ecpErrorCodes = [
	'bad_signature',
	'replay',
	'clock_skew',
	'unknown_type',
	'frame_too_large',
	'rate_limited',
	'revoked',
	'protocol_unsupported',
	'internal',
] as const
export type EcpErrorCode = (typeof ecpErrorCodes)[number]

export type EcpFsGrant = { path: string; mode: 'ro' | 'rw' }
export type EcpEgressMode = 'public' | 'public-and-lan' | 'allowlist' | 'none'

/** The local access grant a context exposes to runs (ECP 8.1). */
export type EcpCommandsGrant = {
	enabled: boolean
	/** ISO time the machine turned commands on (null when off). */
	enabledAt?: string | null
}

export type EcpGrant = {
	fs: Array<EcpFsGrant>
	egress: {
		mode: EcpEgressMode
		hosts?: Array<string>
		ports?: Array<number>
	}
	runtime: { mode: 'all' } | { mode: 'allowlist'; paths: Array<string> }
	/**
	 * Host commands (`kody.command.*`). Only a signed request from the
	 * machine itself turns this on; anyone who can change the context can
	 * turn it off. The daemon also requires its local policy to allow it.
	 */
	commands?: EcpCommandsGrant
	limits: { timeoutMs: number; memoryMb: number; maxConcurrent: number }
	payload: {
		maxRequestBytes: number
		maxResultBytes: number
		resultContentTypes: Array<string>
	}
}

export const ecpDefaultGrant: EcpGrant = {
	fs: [],
	egress: { mode: 'public' },
	runtime: { mode: 'all' },
	limits: { timeoutMs: 90_000, memoryMb: 512, maxConcurrent: 2 },
	payload: {
		maxRequestBytes: 5 * 1024 * 1024,
		maxResultBytes: 100 * 1024,
		resultContentTypes: ['application/json', 'text/plain'],
	},
	commands: { enabled: false },
}

export const ecpGrantMaximums = {
	timeoutMs: 15 * 60_000,
	memoryMb: 8192,
	maxConcurrent: ecpMaxConcurrentRunsCap,
	maxRequestBytes: 5 * 1024 * 1024,
	maxResultBytes: 1024 * 1024,
} as const

export type EcpCapabilities = {
	runtime?: string
	node?: string
	os?: string
	features?: Array<string>
	maxConcurrent?: number
	cpuCount?: number
	memoryMb?: number
	enforcement?: { memory?: string; cpu?: string }
	/** Set when the daemon runs as a background service. */
	service?: 'systemd' | 'launchd'
}

export type EcpRunRequestBody = {
	runId: string
	deadline: number
	acceptBy: number
	requestedBy: {
		userId: string
		handle: string | null
		orgId: string
		orgSlug: string | null
	}
	source: { kind: 'code'; code: string; sha256: string }
	params: unknown
	conversationId?: string
	credentialPicks: Record<string, Array<string>>
	limits: { timeoutMs: number; maxResultBytes: number; memoryMb: number }
	grantVersion: number
	apiUrl: string
	/** True for runs whose requester is not the operator. */
	sharedRun?: boolean
}

export type EcpRunResultBody = {
	runId: string
	content?: Array<unknown>
	structuredContent?: Record<string, unknown>
	isError: boolean
	startedAt: number
	endedAt: number
	resultBytes: number
	sha256?: string
	enforced?: { memory?: 'cgroup' | 'advisory'; cpu?: string }
	timing?: EcpRunTiming
}

/** Where a run's time went on the daemon, in ms on the daemon's clock. */
export type EcpRunTiming = {
	/** run.commit received until the run started. */
	queueMs: number
	/** Start until the module was ready (package graph + workerd start). */
	setupMs: number
	packageGraphMs?: number
	packageGraphCached?: boolean
	executeMs: number
	/** run.commit received until the result was sent. */
	daemonMs: number
}

export type EcpFramePayload = {
	v: number
	t: string
	ec: string
	sid: string
	seq: number
	ts: number
	re?: number
	body: Record<string, unknown>
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseFramePayload(value: unknown): EcpFramePayload | null {
	if (!isRecord(value)) return null
	const { v, t, ec, sid, seq, ts, re, body } = value
	if (typeof v !== 'number' || typeof t !== 'string' || !t) return null
	if (typeof ec !== 'string' || typeof sid !== 'string') return null
	if (typeof seq !== 'number' || !Number.isSafeInteger(seq)) return null
	if (typeof ts !== 'number' || !Number.isFinite(ts)) return null
	if (re !== undefined && (typeof re !== 'number' || !Number.isSafeInteger(re)))
		return null
	if (!isRecord(body)) return null
	return {
		v,
		t,
		ec,
		sid,
		seq,
		ts,
		...(re === undefined ? {} : { re }),
		body,
	}
}

export type FrameDecodeResult =
	| { kind: 'ping' }
	| { kind: 'frame'; envelope: EcpEnvelope }
	| { kind: 'invalid'; code: 'bad_signature' | 'frame_too_large' }

/**
 * Classify one inbound text message. The fixed ping is the only unsigned
 * frame; an unsigned ping with any payload, or any other unsigned frame, is
 * rejected (decision 2).
 */
export function classifyFrameText(text: string): FrameDecodeResult {
	if (text.length > ecpMaxFrameBytes) {
		return { kind: 'invalid', code: 'frame_too_large' }
	}
	if (text === ecpPingFrame) return { kind: 'ping' }
	let parsed: unknown
	try {
		parsed = JSON.parse(text)
	} catch {
		return { kind: 'invalid', code: 'bad_signature' }
	}
	const envelope = parseEnvelope(parsed)
	if (!envelope) return { kind: 'invalid', code: 'bad_signature' }
	return { kind: 'frame', envelope }
}

export async function signFrame(input: {
	privateKey: EcpCryptoKey
	kid: string
	payload: EcpFramePayload
}) {
	const envelope = await signEnvelope({
		prefix: ecpFrameSignaturePrefix,
		payload: input.payload,
		privateKey: input.privateKey,
		kid: input.kid,
	})
	return JSON.stringify(envelope)
}

export type FrameVerifyResult =
	| { ok: true; frame: EcpFramePayload }
	| { ok: false; code: 'bad_signature' | 'replay' | 'clock_skew' }

/**
 * Verify signature, then context id, session, sequence and clock. `lastSeq`
 * is the last accepted seq in this direction (0 before the first frame).
 */
export async function verifyFrame(input: {
	envelope: EcpEnvelope
	publicKey: EcpCryptoKey
	expect: { ec: string; sid: string; lastSeq: number; kid?: string }
	now: number
}): Promise<FrameVerifyResult> {
	if (input.expect.kid !== undefined && input.envelope.k !== input.expect.kid) {
		return { ok: false, code: 'bad_signature' }
	}
	const decoded = await verifyEnvelope({
		prefix: ecpFrameSignaturePrefix,
		envelope: input.envelope,
		publicKey: input.publicKey,
	})
	const frame = parseFramePayload(decoded)
	if (!frame || frame.v !== ecpFrameFormatVersion) {
		return { ok: false, code: 'bad_signature' }
	}
	if (frame.ec !== input.expect.ec || frame.sid !== input.expect.sid) {
		return { ok: false, code: 'bad_signature' }
	}
	if (checkNextSeq(input.expect.lastSeq, frame.seq) !== 'ok') {
		return { ok: false, code: 'replay' }
	}
	if (checkFrameClock(frame.ts, input.now) !== 'ok') {
		return { ok: false, code: 'clock_skew' }
	}
	return { ok: true, frame }
}

/** Highest common protocol major, or null. */
export function negotiateProtocol(
	offered: unknown,
	supported: ReadonlyArray<number> = [ecpProtocolVersion],
): number | null {
	if (!isRecord(offered)) return null
	const { min, max } = offered
	if (typeof min !== 'number' || typeof max !== 'number') return null
	const common = supported.filter((major) => major >= min && major <= max)
	return common.length ? Math.max(...common) : null
}

/** Unknown types prefixed `x-` are ignored; others get `unknown_type`. */
export function unknownFrameTypeDisposition(type: string) {
	return type.startsWith('x-') ? 'ignore' : 'unknown_type'
}
