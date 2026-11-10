import { sha256Hex } from '@kody-internal/shared/sha256.ts'
import type { PackageAppAnonymousRealtimeMode } from '#worker/package-registry/types.ts'

export const publicRealtimeNotOptedInMessage =
	'Realtime features of this app are only available to members of the organization that owns it.'

export const publicRealtimeUnapprovedMessage =
	'This version of the app is waiting for its owner to approve it for public visitors.'

/**
 * Whether a visitor who is not an org member (anonymous, or signed in from
 * outside the org) may open this app's realtime sockets. The app must be
 * internet-visible, opt in with `kody.app.realtime.anonymous`, and serve the
 * commit its owner approved, the same pin anonymous HTTP uses (ADR 0069).
 * Opting in on an app that is not internet-visible does nothing.
 */
export function decidePublicRealtimeAccess(input: {
	isInternetVisible: boolean
	mode: PackageAppAnonymousRealtimeMode | null
	approvedPublishedCommit: string | null | undefined
	publishedCommit: string | null | undefined
}):
	| { ok: true; mode: PackageAppAnonymousRealtimeMode; approvedCommit: string }
	| { ok: false; message: string } {
	if (!input.isInternetVisible || !input.mode) {
		return { ok: false, message: publicRealtimeNotOptedInMessage }
	}
	if (
		!input.publishedCommit ||
		input.approvedPublishedCommit !== input.publishedCommit
	) {
		return { ok: false, message: publicRealtimeUnapprovedMessage }
	}
	return { ok: true, mode: input.mode, approvedCommit: input.publishedCommit }
}

/**
 * Hashed client IP for the per-IP socket caps, salted with the package id so
 * the tag cannot be joined across apps. The raw IP is never stored.
 */
export async function hashRealtimeClientIp(input: {
	packageId: string
	request: Request
}) {
	const ip = input.request.headers.get('CF-Connecting-IP')?.trim() || 'unknown'
	const digest = await sha256Hex(`package-realtime:${input.packageId}:${ip}`)
	return digest.slice(0, 32)
}
