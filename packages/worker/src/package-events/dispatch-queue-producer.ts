import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { type RequestLineage } from '@kody-internal/shared/request-context.ts'
import { parseRequestLineage } from '#worker/request-context/request-context.ts'

export type PackageEventsDispatchQueueMessage = {
	userId: OwnerId
	topic: string
	idempotencyKey: string
	payload: Record<string, unknown>
	source: {
		packageId: string
		kodyId: string
	}
	/**
	 * Runtime invocation depth carried across the queue boundary so
	 * event-driven package chains (A emits, B's handler emits, ...) keep the
	 * same cycle protection as synchronous host invoke chains.
	 */
	invokeDepth: number
	/**
	 * Set when the emitting package declared this topic with `mcp: true` at
	 * dispatch time. Absent means no MCP Events fan-out (fail closed for
	 * messages enqueued before the field existed).
	 */
	mcp?: true
	/** ISO time `events.dispatch` accepted the event (MCP occurrence timestamp). */
	emittedAt?: string
	/**
	 * The run that emitted the event; subscriber handlers inherit it. Absent
	 * on messages enqueued before the field existed.
	 */
	lineage?: RequestLineage
	/**
	 * Resource change event chain depth of the emitting run, so a chain that
	 * passes through a package event keeps counting toward its limit.
	 */
	resourceEventDepth?: number
}

export function parsePackageEventsDispatchQueueMessage(
	body: unknown,
): PackageEventsDispatchQueueMessage | null {
	if (!body || typeof body !== 'object' || Array.isArray(body)) return null
	const record = body as Record<string, unknown>
	const userId = record['userId']
	const topic = record['topic']
	const idempotencyKey = record['idempotencyKey']
	const payload = record['payload']
	const source = record['source']
	const invokeDepth = record['invokeDepth']
	if (
		typeof userId !== 'string' ||
		!userId.trim() ||
		typeof topic !== 'string' ||
		!topic.trim() ||
		typeof idempotencyKey !== 'string' ||
		!idempotencyKey.trim() ||
		!payload ||
		typeof payload !== 'object' ||
		Array.isArray(payload) ||
		!source ||
		typeof source !== 'object' ||
		Array.isArray(source) ||
		typeof invokeDepth !== 'number' ||
		!Number.isInteger(invokeDepth) ||
		invokeDepth < 0
	) {
		return null
	}
	const sourceRecord = source as Record<string, unknown>
	const packageId = sourceRecord['packageId']
	const kodyId = sourceRecord['kodyId']
	if (
		typeof packageId !== 'string' ||
		!packageId.trim() ||
		typeof kodyId !== 'string' ||
		!kodyId.trim()
	) {
		return null
	}
	const emittedAt = record['emittedAt']
	const lineage = parseRequestLineage(record['lineage'])
	const resourceEventDepth = record['resourceEventDepth']
	return {
		userId: userId.trim() as OwnerId,
		topic: topic.trim(),
		idempotencyKey: idempotencyKey.trim(),
		payload: payload as Record<string, unknown>,
		source: { packageId: packageId.trim(), kodyId: kodyId.trim() },
		invokeDepth,
		...(record['mcp'] === true ? { mcp: true as const } : {}),
		...(typeof emittedAt === 'string' && !Number.isNaN(Date.parse(emittedAt))
			? { emittedAt }
			: {}),
		...(lineage ? { lineage } : {}),
		...(typeof resourceEventDepth === 'number' &&
		Number.isInteger(resourceEventDepth) &&
		resourceEventDepth > 0
			? { resourceEventDepth }
			: {}),
	}
}
