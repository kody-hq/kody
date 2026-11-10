export type UiFeedback =
	| { tone: 'info'; message: string }
	| { tone: 'error'; message: string }

export function createUiFeedback(
	message: string | null | undefined,
	tone: UiFeedback['tone'] = 'info',
): UiFeedback | null {
	return message == null ? null : { tone, message }
}
