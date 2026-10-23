import { readE2eCloudflareMockState } from '../tools/e2e-cloudflare-mock-state.ts'

const verificationEmailSubject = 'Verify your email to finish setting up Kody'

const connectAgentEmailSubject = 'Connect the agent you already use'

export type MockEmailMessage = {
	id: string
	from_email: string
	to_json: string
	subject: string
	html: string
	text: string | null
}

type MockEmailListResponse = {
	count: number
	messages: Array<MockEmailMessage>
}

export function extractVerifyEmailPath(body: string) {
	const match = body.match(
		/https?:\/\/[^\s"'<>]+\/verify-email\?token=[a-f0-9]+(?:[&?][^\s"'<>]*)?/i,
	)
	if (!match?.[0]) return null
	const url = new URL(match[0].replaceAll('&amp;', '&'))
	return `${url.pathname}${url.search}`
}

export async function listE2eCloudflareMockMessages() {
	const mock = readE2eCloudflareMockState()
	const url = new URL('/__mocks/messages', mock.origin)
	url.searchParams.set('token', mock.token)
	url.searchParams.set('limit', '100')
	const response = await fetch(url)
	if (!response.ok) {
		throw new Error(
			`Cloudflare mock message list failed (${String(response.status)}).`,
		)
	}
	return (await response.json()) as MockEmailListResponse
}

function messageReaches(message: MockEmailMessage, recipient: string) {
	return message.to_json.toLowerCase().includes(recipient.trim().toLowerCase())
}

export function findVerificationEmail(
	messages: Array<MockEmailMessage>,
	recipient: string,
) {
	return (
		messages.find((message) => {
			if (message.subject !== verificationEmailSubject) return false
			return messageReaches(message, recipient)
		}) ?? null
	)
}

export function findConnectAgentEmail(
	messages: Array<MockEmailMessage>,
	recipient: string,
) {
	return (
		messages.find((message) => {
			if (message.subject !== connectAgentEmailSubject) return false
			return messageReaches(message, recipient)
		}) ?? null
	)
}
