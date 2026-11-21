import { Logger, type Layer } from 'effect'

export type CapturedLog = { readonly level: string; readonly message: unknown }

/** Replaces the console loggers so a test can assert what was logged. */
export function captureLogs() {
	const logs: Array<CapturedLog> = []
	const layer = Logger.layer([
		Logger.make(({ logLevel, message }) => {
			logs.push({ level: logLevel, message })
		}),
	])
	return { logs, layer: layer as Layer.Layer<never> }
}
