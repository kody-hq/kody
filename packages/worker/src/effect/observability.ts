import { Exit, Layer, Logger, Option, Tracer } from 'effect'

/**
 * Spans end as one structured `effect-span` console line, which Workers
 * Logs (the Worker's observability sink) indexes alongside the JSON log
 * lines that carry the same trace and span ids.
 */
const workersLogsTracer = Tracer.make({
	span: (options) => {
		const span = new Tracer.NativeSpan(options)
		const end = span.end.bind(span)
		span.end = (endTime, exit) => {
			end(endTime, exit)
			console.log(
				JSON.stringify({
					message: 'effect-span',
					name: span.name,
					traceId: span.traceId,
					spanId: span.spanId,
					parentSpanId: Option.getOrUndefined(
						Option.map(span.parent, (parent) => parent.spanId),
					),
					durationMs: Number(endTime - span.startTime) / 1_000_000,
					status: Exit.isSuccess(exit) ? 'ok' : 'error',
					attributes: Object.fromEntries(span.attributes),
				}),
			)
		}
		return span
	},
})

/** JSON lines on the console method that matches the level, so Workers Logs keeps severity. */
const workersLogsLogger = Logger.make((options) => {
	const line = Logger.formatJson.log(options)
	switch (options.logLevel) {
		case 'Fatal':
		case 'Error':
			return console.error(line)
		case 'Warn':
			return console.warn(line)
		default:
			return console.log(line)
	}
})

export const WorkerObservability = Layer.mergeAll(
	Logger.layer([workersLogsLogger]),
	Layer.succeed(Tracer.Tracer, workersLogsTracer),
)
