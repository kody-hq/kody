import { createFileRoute } from '@tanstack/react-router'
import { agentSkillMarkdownHttp } from '#start/server/protocol-handlers'
export const Route = createFileRoute(
	'/.well-known_/agent-skills_/$skillId_/SKILL.md',
)({
	staticData: { documentNavigation: true },
	server: { handlers: { GET: agentSkillMarkdownHttp } },
})
