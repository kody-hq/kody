import { expect, test, vi } from 'vitest'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import {
	classifyExecuteInterpretable,
	executeInterpretableTelemetryIndex,
	recordExecuteInterpretableEvent,
} from './execute-interpretable.ts'

test('classifies glue-only execute modules and each documented disqualifier', async () => {
	const cases: Array<[source: string, reason: string]> = [
		[
			`import { kody } from 'kody:runtime'
export default async function main() {
	return await kody.capability_id({})
}`,
			'glue',
		],
		[
			`import { email, workflows } from 'kody:runtime'
export default async function main() {
	return await email.send({ to: 'a@example.com', subject: 'hi', text: 'hi' })
}`,
			'glue',
		],
		['export default async function main() { return { ok: true } }', 'glue'],
		[
			`import type { Config } from 'kody:@owner/types/config'
import { kody } from 'kody:runtime'
export default async function main() {
	return await kody.capability_id({})
}`,
			'glue',
		],
		[
			`import whatShipped from 'kody:@you/kody-bot-shipped/whatShipped'
export default async function main() {
	return await whatShipped({})
}`,
			'has_package_import',
		],
		[
			`const mod = await import('kody:@scope/notes/note-list')
export default async function main() {
	return await mod.default({})
}`,
			'has_package_import',
		],
		[
			`import { get } from 'lodash'
export default async function main() {
	return get({ a: 1 }, 'a')
}`,
			'has_npm',
		],
		[
			`import { createHash } from 'node:crypto'
export default async function main() {
	return createHash('sha256').update('x').digest('hex')
}`,
			'has_node_builtin',
		],
		[
			`export default async function main() {
	return await fetch('https://example.com')
}`,
			'has_fetch',
		],
		[
			`export default async function main() {
	return await globalThis.fetch('https://example.com')
}`,
			'has_fetch',
		],
		[
			`import { createAuthenticatedFetch } from 'kody:runtime'
export default async function main() {
	const authFetch = createAuthenticatedFetch('github')
	return await authFetch('https://api.github.com/user')
}`,
			'has_fetch',
		],
		[
			`import { oauthClientCredentials } from 'kody:runtime'
export default async function main() {
	return await oauthClientCredentials({
		tokenUrl: 'https://example.com/oauth/token',
		clientIdSecret: 'client-id',
		clientSecretSecret: 'client-secret',
	})
}`,
			'has_fetch',
		],
		[
			`const specifier = condition ? 'kody:runtime' : 'lodash'
const mod = await import(specifier)
export default async function main() {
	return mod
}`,
			'has_dynamic_import',
		],
		[
			`import { connect } from 'cloudflare:sockets'
export default async function main() {
	return connect
}`,
			'has_unsupported_import',
		],
		[
			`import helper from './helper.ts'
export default async function main() {
	return helper()
}`,
			'has_unsupported_import',
		],
		['export default async function main( {', 'unparseable'],
		// The first disqualifier wins when several apply.
		[
			`import whatShipped from 'kody:@you/bot/whatShipped'
import { get } from 'lodash'
export default async function main() {
	return await fetch('https://example.com')
}`,
			'has_package_import',
		],
	]
	expect(
		await Promise.all(
			cases.map(([source]) => classifyExecuteInterpretable(source)),
		),
	).toEqual(
		cases.map(([, reason]) => ({
			class: reason === 'glue' ? 'interpretable' : 'non_interpretable',
			reason,
		})),
	)
})

test('records a privacy-safe payload and never throws when unavailable or broken', async () => {
	const writeDataPoint = vi.fn()
	await recordExecuteInterpretableEvent(
		{
			EXECUTE_INTERPRETABLE_EVENTS: {
				writeDataPoint,
			} as unknown as AnalyticsEngineDataset,
		},
		{
			source: `import { kody } from 'kody:runtime'
export default async function main() {
	return await kody.secretGet({ name: 'token' })
}`,
		},
	)
	expect(writeDataPoint).toHaveBeenCalledExactlyOnceWith({
		indexes: [executeInterpretableTelemetryIndex],
		blobs: ['interpretable', 'glue'],
		doubles: [1],
	})

	await recordExecuteInterpretableEvent(
		{
			EXECUTE_INTERPRETABLE_EVENTS: {
				writeDataPoint,
			} as unknown as AnalyticsEngineDataset,
		},
		{
			source: `import secretHelper from 'kody:@private-owner/secret-package/private-export'
export default async function main() {
	return await secretHelper({ token: 'super-secret-value' })
}`,
		},
	)
	expect(writeDataPoint).toHaveBeenLastCalledWith({
		indexes: [executeInterpretableTelemetryIndex],
		blobs: ['non_interpretable', 'has_package_import'],
		doubles: [1],
	})
	expect(JSON.stringify(writeDataPoint.mock.calls)).not.toContain('private')
	expect(JSON.stringify(writeDataPoint.mock.calls)).not.toContain(
		'super-secret',
	)

	await expect(
		recordExecuteInterpretableEvent(
			{},
			{
				source:
					"import { kody } from 'kody:runtime'\nexport default async function main() {}",
			},
		),
	).resolves.toBeUndefined()

	consoleWarn.mockImplementation(() => {})
	await expect(
		recordExecuteInterpretableEvent(
			{
				EXECUTE_INTERPRETABLE_EVENTS: {
					writeDataPoint() {
						throw new Error('unavailable')
					},
				} as unknown as AnalyticsEngineDataset,
			},
			{ source: 'export default async function main() { return 1 }' },
		),
	).resolves.toBeUndefined()
	expect(consoleWarn).toHaveBeenCalledExactlyOnceWith(
		'execute-interpretable-event-failed',
		expect.any(Error),
	)
})
