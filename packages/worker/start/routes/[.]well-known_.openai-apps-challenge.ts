import { createFileRoute } from '@tanstack/react-router'
import { openaiAppsChallengeHttp } from '#start/server/protocol-handlers'
export const Route = createFileRoute('/.well-known_/openai-apps-challenge')({
	server: { handlers: { GET: openaiAppsChallengeHttp } },
})
