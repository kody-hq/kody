import { expect, test, vi } from 'vitest'
import {
	getRequestContext,
	runWithRequestContext,
} from '../src/request-context.ts'
import { logDocumentErrors } from './document-error-log.ts'

test.each([
	[false, 'the D1 primary'],
	[true, 'a D1 replica session'],
])(
	'a failed route logs its error and D1 source (replica session: %s)',
	async (replica, source) => {
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
		const request = new Request('https://kody.codes/@kody')
		await runWithRequestContext(request, async () => {
			if (replica) {
				getRequestContext(request)!.d1ReplicaReads = {
					start: 'first-unconstrained',
					allowed: true,
					session: {} as D1DatabaseSession,
				}
			}
			logDocumentErrors([
				{ status: 'success', routeId: '__root__' },
				{
					status: 'error',
					routeId: '/$owner',
					error: new TypeError('no rows'),
				},
			])
		})
		expect(consoleError).toHaveBeenCalledTimes(1)
		expect(consoleError).toHaveBeenCalledWith(
			`Document route /$owner failed while reading ${source}:`,
			expect.stringMatching(/^TypeError: no rows\n.*document-error-log/s),
		)
		consoleError.mockRestore()
	},
)
