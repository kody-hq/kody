import { expect, test, vi } from 'vitest'
import type { ResolvedConfig } from 'vite'
import {
	isThirdPartySourcemapWarning,
	suppressThirdPartySourcemapWarnings,
} from './vite-suppress-sourcemap-warnings.ts'

const thirdPartyWarning =
	'Sourcemap for "/workspace/node_modules/@modelcontextprotocol/sdk/dist/esm/types.js" points to missing source files'
const firstPartyWarning =
	'Sourcemap for "/workspace/packages/worker/src/index.ts" points to missing source files'

test('matches only the third-party missing-sourcemap warning', () => {
	expect(isThirdPartySourcemapWarning(thirdPartyWarning)).toBe(true)
	expect(
		isThirdPartySourcemapWarning(
			'Sourcemap for "/workspace/node_modules/cron-schedule/dist/cron.js" points to missing source files',
		),
	).toBe(true)

	// A first-party file with a broken sourcemap is our bug and must surface.
	expect(isThirdPartySourcemapWarning(firstPartyWarning)).toBe(false)
	expect(isThirdPartySourcemapWarning('Some unrelated vite warning')).toBe(
		false,
	)
	expect(
		isThirdPartySourcemapWarning(
			`prefix ${thirdPartyWarning} suffix that changes the message`,
		),
	).toBe(false)
})

test('plugin drops third-party sourcemap warnings and forwards everything else', () => {
	const warn = vi.fn()
	const warnOnce = vi.fn()
	const config = {
		logger: { warn, warnOnce },
	} as unknown as ResolvedConfig

	const plugin = suppressThirdPartySourcemapWarnings()
	const configResolved = plugin.configResolved
	if (typeof configResolved !== 'function') {
		throw new Error('expected configResolved hook to be a function')
	}
	configResolved.call(undefined as never, config)

	config.logger.warn(thirdPartyWarning)
	config.logger.warnOnce(thirdPartyWarning)
	expect(warn).not.toHaveBeenCalled()
	expect(warnOnce).not.toHaveBeenCalled()

	config.logger.warn(firstPartyWarning)
	config.logger.warnOnce('another real warning', { timestamp: true })
	expect(warn).toHaveBeenCalledTimes(1)
	expect(warn).toHaveBeenCalledWith(firstPartyWarning, undefined)
	expect(warnOnce).toHaveBeenCalledTimes(1)
	expect(warnOnce).toHaveBeenCalledWith('another real warning', {
		timestamp: true,
	})
})
