import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import {
	userMeterNamespace,
	userMeterRpc,
	type UserMeterEnv,
} from '#worker/entitlements/user-meter-client.ts'

/**
 * Best-effort last-heard time for an inbound MCP OAuth `clientId`. Written
 * from successful bearer validation onto the per-user UserMeter (0002:
 * high-write, userId-addressed). `waitUntil` keeps the RPC off the awaited
 * MCP path. Durable debounce lives on the DO so a failed stamp or a revoke
 * on another isolate cannot skip the next write.
 */
const inboundMcpConnectionLastUsedMinIntervalMs = 5 * 60 * 1000

function inboundMcpConnectionLastUsedDebounceCutoffIso(
	lastUsedAt: string,
	intervalMs = inboundMcpConnectionLastUsedMinIntervalMs,
) {
	const nextMs = Date.parse(lastUsedAt)
	if (!Number.isFinite(nextMs)) {
		throw new Error(
			`Inbound MCP last-used timestamp must be an ISO datetime; got ${JSON.stringify(lastUsedAt)}.`,
		)
	}
	return new Date(nextMs - intervalMs).toISOString()
}

export function shouldSkipInboundMcpConnectionLastUsedTouch(input: {
	previousLastUsedAt: string | null
	nextLastUsedAt: string
	intervalMs?: number
}) {
	if (!input.previousLastUsedAt) return false
	return (
		input.previousLastUsedAt >=
		inboundMcpConnectionLastUsedDebounceCutoffIso(
			input.nextLastUsedAt,
			input.intervalMs,
		)
	)
}

export async function recordInboundMcpConnectionLastUsed(input: {
	env: UserMeterEnv
	userId: OwnerId
	clientId: string
	lastUsedAt?: string
	nowMs?: number
}): Promise<void> {
	const clientId = input.clientId.trim()
	if (!clientId || !userMeterNamespace(input.env)) return
	const nowMs = input.nowMs ?? Date.now()
	const lastUsedAt = input.lastUsedAt ?? new Date(nowMs).toISOString()
	await userMeterRpc({
		env: input.env,
		userId: input.userId,
	}).touchInboundConnectionLastUsed({
		clientId,
		lastUsedAt,
	})
}

export async function listInboundMcpConnectionLastUsed(input: {
	env: UserMeterEnv
	userId: OwnerId
}): Promise<Map<string, string>> {
	const lastUsed = new Map<string, string>()
	if (!userMeterNamespace(input.env)) return lastUsed
	const rows = await userMeterRpc({
		env: input.env,
		userId: input.userId,
	}).listInboundConnectionLastUsed()
	for (const row of rows) {
		lastUsed.set(row.clientId, row.lastUsedAt)
	}
	return lastUsed
}

export async function forgetInboundMcpConnectionLastUsed(input: {
	env: UserMeterEnv
	userId: OwnerId
	clientId: string
}): Promise<void> {
	const clientId = input.clientId.trim()
	if (!clientId || !userMeterNamespace(input.env)) return
	await userMeterRpc({
		env: input.env,
		userId: input.userId,
	}).forgetInboundConnectionLastUsed({ clientId })
}
