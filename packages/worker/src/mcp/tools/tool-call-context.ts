import { z } from 'zod'

const generatedConversationIdLength = 12
const conversationIdAlphabet = '0123456789abcdefghjkmnpqrstvwxyz'

const conversationIdDescription =
	'Optional short conversation identifier. Ties related calls together. If you already have a `conversationId` from an earlier response in the same conversation, pass it back unchanged. Otherwise omit this field to receive a server-generated ID, then reuse the returned `conversationId` on subsequent calls - this enables optimizations like reduced response size. Do not invent your own `conversationId`.'

const memoryContextDescription =
	'Optional short, structured task context for memory retrieval. Keep it brief and factual rather than hidden reasoning. If durable memory may need to be written or deleted, agents should later run `metaMemoryVerify` before mutating memory.'

const memoryContextFieldDescription =
	'Optional task or goal summary for future memory retrieval.'

const memoryContextListDescription =
	'Optional short phrases that identify important entities, constraints, or references for future memory retrieval.'

export const conversationIdInputField = z
	.string()
	.min(1)
	.max(64)
	.optional()
	.describe(conversationIdDescription)

export const memoryContextInputField = z
	.object({
		task: z
			.string()
			.min(1)
			.max(300)
			.optional()
			.describe(memoryContextFieldDescription),
		query: z
			.string()
			.min(1)
			.max(300)
			.optional()
			.describe(memoryContextFieldDescription),
		entities: z
			.array(z.string().min(1).max(120))
			.max(8)
			.optional()
			.describe(memoryContextListDescription),
		constraints: z
			.array(z.string().min(1).max(120))
			.max(8)
			.optional()
			.describe(memoryContextListDescription),
	})
	.optional()
	.describe(memoryContextDescription)

export function resolveConversationId(
	conversationId: string | null | undefined,
) {
	const normalizedConversationId = conversationId?.trim() ?? ''
	if (normalizedConversationId) return normalizedConversationId
	return generateConversationId()
}

function generateConversationId() {
	const bytes = crypto.getRandomValues(
		new Uint8Array(generatedConversationIdLength),
	)
	return Array.from(
		bytes,
		(byte) => conversationIdAlphabet[byte % conversationIdAlphabet.length],
	).join('')
}

const memoryContextSessionAnalyticsSentence =
	' This organization turned on session analytics, so Kody also reads this once to pick a general category of work, so Kody can improve. It is never stored.'

/**
 * The `memoryContext` field for a tool list. Only an org that opted in to
 * session analytics gets the extra sentence about the second use.
 */
export function memoryContextInputFieldFor(sessionAnalyticsEnabled: boolean) {
	return sessionAnalyticsEnabled
		? memoryContextInputField.describe(
				memoryContextDescription + memoryContextSessionAnalyticsSentence,
			)
		: memoryContextInputField
}
