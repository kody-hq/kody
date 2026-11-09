import { expect, test } from 'vitest'
import { passkeyCeremonyState } from './passkey-ceremony-state.ts'
test('passkey.registration_ui graph', () => {
	expect([...passkeyCeremonyState.events].sort()).toEqual([
		'OPTIONS_OK',
		'SETTLED',
		'SUBMIT',
	])
})
