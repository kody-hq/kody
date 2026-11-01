import { expect, test } from 'vitest'
import { z } from 'zod'
import { parseRouteInput } from './route-input.ts'

const usernameInput = z.object({ username: z.string().min(1) })

test('empty optional username route params become not-found', () => {
	expect(() => parseRouteInput(usernameInput, { username: '' })).toThrow(
		expect.objectContaining({ isNotFound: true }),
	)
})

test('valid route params pass through', () => {
	expect(parseRouteInput(usernameInput, { username: 'owner' })).toEqual({
		username: 'owner',
	})
})
