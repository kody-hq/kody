/**
 * Outbound era classification for Kody-as-client.
 *
 * Client 2.0.0 `classifyProbeOutcome` is not injectable. It treats
 * HeaderMismatch (-32020) and most unrecognized probe failures as a 2025
 * server, then sends `initialize`. Kody applies this policy at the session
 * boundary instead: restore/reconnect drop stored 2025 sessions and force
 * `versionNegotiation: { mode: 'auto' }` so the next connect re-probes with
 * `server/discover`. Unauthenticated (401) and header-mismatch outcomes are
 * not era evidence. `-32022` (UnsupportedProtocolVersion) is a version
 * mismatch, not a 2025 verdict — retry a mutual modern version, do not fall
 * back to `initialize`. Fall back only when the server is actually 2025-era
 * (`-32601` MethodNotFound).
 */

import {
	isFreshModernDiscoverResult,
	modernMcpProtocolVersion,
} from './transport-session.ts'

export const headerMismatchErrorCode = -32020
export const unsupportedProtocolVersionErrorCode = -32022
export const methodNotFoundErrorCode = -32601

export type OutboundMcpProbeSignal =
	| { kind: 'modern' }
	| { kind: 'legacy' }
	| { kind: 'auth-required' }
	| { kind: 'header-mismatch' }
	| { kind: 'unknown' }

export function classifyOutboundMcpProbeSignal(input: {
	httpStatus?: number
	rpcCode?: number
	discoverSupportedVersions?: ReadonlyArray<string>
}): OutboundMcpProbeSignal {
	if (input.httpStatus === 401 || input.httpStatus === 403) {
		return { kind: 'auth-required' }
	}
	if (input.rpcCode === headerMismatchErrorCode) {
		return { kind: 'header-mismatch' }
	}
	if (input.discoverSupportedVersions?.includes(modernMcpProtocolVersion)) {
		return { kind: 'modern' }
	}
	if (input.rpcCode === methodNotFoundErrorCode) {
		return { kind: 'legacy' }
	}
	return { kind: 'unknown' }
}

/**
 * A stored `server_options` blob is not a probe. Client 2.0 persists a 2025
 * session after HeaderMismatch fallback; that is not confirmed-legacy
 * evidence, so restore must re-probe.
 * Remove when: MCP protocol metrics show no 2025-era lane traffic.
 */
export function classifyPersistedMcpSession(input: {
	discoverResult?: unknown
}): OutboundMcpProbeSignal {
	if (isFreshModernDiscoverResult(input.discoverResult)) {
		return { kind: 'modern' }
	}
	return { kind: 'unknown' }
}

export function shouldFallbackToLegacyInitialize(
	signal: OutboundMcpProbeSignal,
): boolean {
	return signal.kind === 'legacy'
}

export function shouldPersistLegacyMcpSession(
	signal: OutboundMcpProbeSignal,
): boolean {
	return signal.kind === 'legacy'
}
