import * as Sentry from '@sentry/cloudflare'
import { Effect, Exit, Layer, Logger, Option, Tracer } from 'effect'

type SentrySpan = ReturnType<typeof Sentry.startInactiveSpan>

const sentrySpans = new WeakMap<Tracer.AnySpan, SentrySpan>()

const nanosToMillis = (nanos: bigint) => Number(nanos / 1_000_000n)

/**
 * Effect's native span, mirrored as a Sentry span. A root Effect span nests
 * under the active Sentry span (the Worker's request or queue transaction),
 * so `Effect.fn` spans land in the traces the Worker already samples.
 */
class SentryMirroredSpan implements Tracer.Span {
	readonly _tag = 'Span'
	private readonly inner: Tracer.Span
	private readonly sentry: SentrySpan
	constructor(inner: Tracer.Span, sentry: SentrySpan) {
		this.inner = inner
		this.sentry = sentry
	}
	get name() {
		return this.inner.name
	}
	get spanId() {
		return this.inner.spanId
	}
	get traceId() {
		return this.inner.traceId
	}
	get parent() {
		return this.inner.parent
	}
	get annotations() {
		return this.inner.annotations
	}
	get status() {
		return this.inner.status
	}
	get attributes() {
		return this.inner.attributes
	}
	get links() {
		return this.inner.links
	}
	get sampled() {
		return this.inner.sampled
	}
	get kind() {
		return this.inner.kind
	}
	end(endTime: bigint, exit: Exit.Exit<unknown, unknown>) {
		this.inner.end(endTime, exit)
		this.sentry.setStatus(
			Exit.isSuccess(exit)
				? { code: 1 }
				: { code: 2, message: Exit.isFailure(exit) ? 'failure' : undefined },
		)
		this.sentry.end(nanosToMillis(endTime))
	}
	attribute(key: string, value: unknown) {
		this.inner.attribute(key, value)
		if (
			typeof value === 'string' ||
			typeof value === 'number' ||
			typeof value === 'boolean'
		) {
			this.sentry.setAttribute(key, value)
		}
	}
	event(name: string, startTime: bigint, attributes?: Record<string, unknown>) {
		this.inner.event(name, startTime, attributes)
	}
	addLinks(links: ReadonlyArray<Tracer.SpanLink>) {
		this.inner.addLinks(links)
	}
}

const sentryTracer = Tracer.make({
	span(options) {
		const inner = Tracer.nativeTracer.span(options)
		const parent = Option.getOrUndefined(options.parent)
		const sentry = Sentry.startInactiveSpan({
			name: options.name,
			op: 'effect',
			startTime: nanosToMillis(options.startTime),
			...(parent && sentrySpans.has(parent)
				? { parentSpan: sentrySpans.get(parent) }
				: {}),
		})
		const span = new SentryMirroredSpan(inner, sentry)
		sentrySpans.set(span, sentry)
		return span
	},
})

/**
 * Spans go to Sentry tracing; `Effect.log*` lines go to the matching console
 * level as JSON (with span and annotations), which Workers Logs indexes.
 */
export const observabilityLayer = Layer.mergeAll(
	Layer.succeed(Tracer.Tracer, sentryTracer),
	Logger.layer([Logger.withLeveledConsole(Logger.formatJson)]),
)

/** One-line Promise edge for callers outside the slice. */
export const runPromiseEdge = <A, E>(effect: Effect.Effect<A, E>) =>
	Effect.runPromise(Effect.provide(effect, observabilityLayer))
