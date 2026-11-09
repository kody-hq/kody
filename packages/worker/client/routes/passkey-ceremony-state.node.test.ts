import { expect, test } from 'vitest'
import { passkeyCeremonyState } from './passkey-ceremony-state.ts'
test('passkey.registration_ui graph', () => {
	expect(passkeyCeremonyState.transitions).toEqual({
		idle: ['requesting'],
		requesting: ['ceremony', 'idle'],
		ceremony: ['idle'],
	})
})
