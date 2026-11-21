import * as Sentry from '@sentry/cloudflare'
import { type Clock, systemClock } from './clock.ts'
import { toRetentionFailure } from './failures.ts'

export type SpanAttributes = Record<string, string | number | boolean | null>

type SpanHandle = {
	setAttribute(key: string, value: string | number | boolean): void
}

const sentrySpanStatusError = 2

function definedAttributes(attributes: SpanAttributes) {
	const out: Record<string, string | number | boolean> = {}
	for (const [key, value] of Object.entries(attributes)) {
		if (value !== null) out[key] = value
	}
	return out
}

/**
 * Runs `fn` inside a Sentry span (exported to the Worker's OTLP/Sentry trace
 * pipeline by `withSentry` on the hosting entrypoint) and emits one
 * structured `retention.span` log line to Workers Logs when it settles.
 * Logs go to console.info so they reach Workers observability without
 * tripping warning budgets; failures are still marked on the span status.
 */
export async function traced<T>(
	name: string,
	attributes: SpanAttributes,
	fn: (span: SpanHandle) => Promise<T>,
	clock: Clock = systemClock,
): Promise<T> {
	const startedAtMs = clock.nowMs()
	const attrs = definedAttributes(attributes)
	return Sentry.startSpan(
		{ name, op: 'retention', attributes: attrs },
		async (span) => {
			const handle: SpanHandle = {
				setAttribute(key, value) {
					attrs[key] = value
					span.setAttribute(key, value)
				},
			}
			try {
				const value = await fn(handle)
				console.info(
					JSON.stringify({
						message: 'retention.span',
						span: name,
						outcome: 'ok',
						durationMs: clock.nowMs() - startedAtMs,
						...attrs,
					}),
				)
				return value
			} catch (error) {
				const failure = toRetentionFailure(name, error)
				span.setStatus({ code: sentrySpanStatusError, message: failure.kind })
				console.info(
					JSON.stringify({
						message: 'retention.span',
						span: name,
						outcome: 'error',
						failureKind: failure.kind,
						errorName: error instanceof Error ? error.name : typeof error,
						durationMs: clock.nowMs() - startedAtMs,
						...attrs,
					}),
				)
				throw error
			}
		},
	)
}
