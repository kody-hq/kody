import { createFileRoute } from '@tanstack/react-router'
import { agentSkillsIndexHttp } from '#start/server/protocol-handlers'
export const Route = createFileRoute('/.well-known_/agent-skills_/index.json')({
	server: { handlers: { GET: agentSkillsIndexHttp } },
})
