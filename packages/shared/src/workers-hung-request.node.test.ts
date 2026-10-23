import { expect, test } from 'vitest'
import {
	isWorkersHungRequestCanceledError,
	isWorkersHungRequestCanceledMessage,
} from './workers-hung-request.ts'

const platformHungMessage =
	"The Workers runtime canceled this request because it detected that your Worker's code had hung and would never generate a response. Refer to: https://developers.cloudflare.com/workers/observability/errors/"

test('isWorkersHungRequestCanceledMessage matches the stable platform hung clause', () => {
	expect(isWorkersHungRequestCanceledMessage(platformHungMessage)).toBe(true)
	expect(
		isWorkersHungRequestCanceledMessage(`Error: ${platformHungMessage}`),
	).toBe(true)
	expect(
		isWorkersHungRequestCanceledMessage(
			'A hanging Promise was canceled. Something else.',
		),
	).toBe(false)
	expect(isWorkersHungRequestCanceledMessage('D1_ERROR: SQLITE_BUSY')).toBe(
		false,
	)
})

test('isWorkersHungRequestCanceledError walks the cause chain', () => {
	expect(isWorkersHungRequestCanceledError(platformHungMessage)).toBe(true)
	expect(
		isWorkersHungRequestCanceledError(new Error(platformHungMessage)),
	).toBe(true)
	expect(
		isWorkersHungRequestCanceledError(
			new Error('wrapper', { cause: new Error(platformHungMessage) }),
		),
	).toBe(true)
	expect(isWorkersHungRequestCanceledError(new Error('other'))).toBe(false)
})
