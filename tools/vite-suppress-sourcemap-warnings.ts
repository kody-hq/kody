import type { Plugin } from 'vite'

// Several npm packages (e.g. @modelcontextprotocol/sdk, cron-schedule) ship
// sourcemaps whose `sources` files are not published, and Vite warns once per
// transformed file ("Sourcemap ... points to missing source files"). That is
// third-party packaging noise we cannot act on. Only that exact message for
// node_modules files is dropped; every other Vite warning still surfaces so
// real problems are never silently suppressed (see the companion test).
const thirdPartySourcemapWarningPattern =
	/^Sourcemap for ".*\/node_modules\/.*" points to missing source files$/

export function isThirdPartySourcemapWarning(message: string): boolean {
	return thirdPartySourcemapWarningPattern.test(message)
}

export function suppressThirdPartySourcemapWarnings(): Plugin {
	return {
		name: 'kody:suppress-third-party-sourcemap-warnings',
		configResolved(config) {
			const originalWarn = config.logger.warn.bind(config.logger)
			const originalWarnOnce = config.logger.warnOnce.bind(config.logger)
			config.logger.warn = (message, options) => {
				if (isThirdPartySourcemapWarning(message)) return
				originalWarn(message, options)
			}
			config.logger.warnOnce = (message, options) => {
				if (isThirdPartySourcemapWarning(message)) return
				originalWarnOnce(message, options)
			}
		},
	}
}
