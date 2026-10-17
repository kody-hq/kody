import { type Handle } from 'remix/component'
import { readJson } from '#client/routes/account-approval-shared.ts'
import { type EmailNotificationDestination } from '#universal/email-destinations.ts'
import { type AccountEmailDestinationsLoaderData } from '#universal/loader-data.ts'

const destinationsApiPath = '/account/email-destinations.json'

export function createAccountEmailDestinations(handle: Handle) {
	let destinations: Array<EmailNotificationDestination> = []
	let additionalLimit = 0
	let additionalRemaining = 0
	let draftEmail = ''
	let status: 'idle' | 'sending' = 'idle'
	let message: string | null = null
	let tone: 'error' | 'info' = 'info'
	let pendingId: string | null = null

	function applyPayload(payload: AccountEmailDestinationsLoaderData) {
		destinations = payload.destinations
		additionalLimit = payload.additionalLimit
		additionalRemaining = payload.additionalRemaining
	}

	function updateDraftEmail(event: InputEvent) {
		if (!(event.currentTarget instanceof HTMLInputElement)) return
		draftEmail = event.currentTarget.value
		handle.update()
	}

	async function mutate(body: Record<string, string>) {
		status = 'sending'
		pendingId = body.id ?? null
		message = null
		handle.update()
		try {
			const response = await fetch(destinationsApiPath, {
				method: 'POST',
				headers: {
					Accept: 'application/json',
					'Content-Type': 'application/json',
				},
				credentials: 'include',
				body: JSON.stringify(body),
			})
			const payload = await readJson<
				AccountEmailDestinationsLoaderData & { error?: string }
			>(response)
			if (!response.ok || !payload?.ok) {
				message = payload?.error ?? 'Unable to update email destinations.'
				tone = 'error'
				if (payload?.destinations) {
					applyPayload(payload)
					if (body.action === 'add') draftEmail = ''
				}
				return
			}
			applyPayload(payload)
			if (body.action === 'add') draftEmail = ''
			message = payload.message ?? 'Email destinations updated.'
			tone = 'info'
		} catch {
			message = 'Unable to update email destinations.'
			tone = 'error'
		} finally {
			status = 'idle'
			pendingId = null
			handle.update()
		}
	}

	async function handleAddSubmit(event: SubmitEvent) {
		event.preventDefault()
		await mutate({ action: 'add', email: draftEmail })
	}

	async function resend(id: string) {
		await mutate({ action: 'resend', id })
	}

	async function setDefault(id: string) {
		await mutate({ action: 'setDefault', id })
	}

	async function remove(id: string) {
		await mutate({ action: 'remove', id })
	}

	return {
		get destinations() {
			return destinations
		},
		get additionalLimit() {
			return additionalLimit
		},
		get additionalRemaining() {
			return additionalRemaining
		},
		get draftEmail() {
			return draftEmail
		},
		get status() {
			return status
		},
		get message() {
			return message
		},
		get tone() {
			return tone
		},
		get pendingId() {
			return pendingId
		},
		applyPayload,
		updateDraftEmail,
		handleAddSubmit,
		resend,
		setDefault,
		remove,
	}
}
