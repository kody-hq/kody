import type { ProfileVisibility } from '#universal/loader-data.ts'

export type AccountProfileSavePayload = {
	ok?: boolean
	error?: unknown
}

export type AccountProfileSaveResult =
	| { status: 'error'; message: string }
	| { status: 'saved'; message: string }
	| { status: 'noop' }

export function readApiErrorMessage(payload: unknown, fallback: string) {
	if (!payload || typeof payload !== 'object') return fallback
	const error = (payload as { error?: unknown }).error
	if (typeof error === 'string' && error.trim()) return error
	if (error && typeof error === 'object' && 'message' in error) {
		const message = (error as { message?: unknown }).message
		if (typeof message === 'string' && message.trim()) return message
	}
	return fallback
}

export function readProfileFormValues(
	form: EventTarget | null,
	fallback: {
		displayName: string
		bio: string
		profileVisibility: ProfileVisibility
	},
) {
	if (
		typeof HTMLFormElement === 'undefined' ||
		!(form instanceof HTMLFormElement)
	) {
		return fallback
	}
	const data = new FormData(form)
	const displayName = String(data.get('displayName') ?? fallback.displayName)
	const bio = String(data.get('bio') ?? fallback.bio)
	const visibilityValue = data.get('profileVisibility')
	const profileVisibility =
		visibilityValue === 'public' || visibilityValue === 'private'
			? visibilityValue
			: fallback.profileVisibility
	return {
		displayName,
		bio,
		profileVisibility,
	}
}

export function interpretAccountProfileSave(input: {
	profileFieldsChanged: boolean
	responseOk: boolean
	payload: AccountProfileSavePayload | null
}): AccountProfileSaveResult {
	if (!input.responseOk || !input.payload?.ok) {
		return {
			status: 'error',
			message: readApiErrorMessage(input.payload, 'Unable to save profile.'),
		}
	}
	if (!input.profileFieldsChanged) return { status: 'noop' }
	return { status: 'saved', message: 'Profile saved.' }
}
