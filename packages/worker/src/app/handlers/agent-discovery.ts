import { getAppBaseUrl } from '#worker/app-base-url.ts'
import { jsonResponse } from '#worker/json-response.ts'
import {
	buildAgentSkillsIndex,
	buildApiCatalog,
	buildAuthMarkdown,
	buildMcpServerCard,
	buildRobotsTxt,
	buildSecurityTxt,
	buildSitemapXml,
	discoveryDocumentHeaders,
	getAgentSkill,
	openaiAppsChallengeToken,
} from '#app/agent-discovery.ts'
import { markdownResponse } from '#app/markdown-negotiation.ts'

function discoveryOrigin(env: Env, request: Request) {
	return getAppBaseUrl({ env, requestUrl: request.url })
}

export function createRobotsTxtHandler(env: Env) {
	return async ({ request }: { request: Request }) => {
		const origin = discoveryOrigin(env, request)
		return new Response(buildRobotsTxt(origin), {
			status: 200,
			headers: discoveryDocumentHeaders('text/plain; charset=utf-8'),
		})
	}
}

export function createSitemapHandler(env: Env) {
	return async ({ request }: { request: Request }) => {
		const origin = discoveryOrigin(env, request)
		return new Response(buildSitemapXml(origin), {
			status: 200,
			headers: discoveryDocumentHeaders('application/xml; charset=utf-8'),
		})
	}
}

export function createMcpServerCardHandler(env: Env) {
	return async ({ request }: { request: Request }) => {
		const origin = discoveryOrigin(env, request)
		return jsonResponse(buildMcpServerCard(origin), {
			headers: discoveryDocumentHeaders('application/json; charset=utf-8'),
		})
	}
}

export function createApiCatalogHandler(env: Env) {
	return async ({ request }: { request: Request }) => {
		const origin = discoveryOrigin(env, request)
		return jsonResponse(buildApiCatalog(origin), {
			headers: discoveryDocumentHeaders(
				'application/linkset+json; charset=utf-8',
			),
		})
	}
}

export function createAuthMarkdownHandler(env: Env) {
	return async ({ request }: { request: Request }) => {
		const origin = discoveryOrigin(env, request)
		const response = markdownResponse(buildAuthMarkdown(origin))
		const headers = new Headers(response.headers)
		headers.set('Access-Control-Allow-Origin', '*')
		headers.set('Cache-Control', 'public, max-age=300')
		return new Response(response.body, {
			status: response.status,
			headers,
		})
	}
}

export function createAgentSkillsIndexHandler(env: Env) {
	return async ({ request }: { request: Request }) => {
		const origin = discoveryOrigin(env, request)
		return jsonResponse(await buildAgentSkillsIndex(origin), {
			headers: discoveryDocumentHeaders('application/json; charset=utf-8'),
		})
	}
}

export function createAgentSkillMarkdownHandler(_env: Env) {
	return async ({ params }: { params: { skillId: string } }) => {
		const skill = getAgentSkill(params.skillId)
		if (!skill) {
			return markdownResponse('# Skill not found\n', 404)
		}
		const response = markdownResponse(skill.body)
		const headers = new Headers(response.headers)
		headers.set('Access-Control-Allow-Origin', '*')
		headers.set('Cache-Control', 'public, max-age=300')
		return new Response(response.body, {
			status: response.status,
			headers,
		})
	}
}

export function createSecurityTxtHandler(env: Env) {
	return async ({ request }: { request: Request }) => {
		const origin = discoveryOrigin(env, request)
		return new Response(buildSecurityTxt(origin), {
			status: 200,
			headers: discoveryDocumentHeaders('text/plain; charset=utf-8'),
		})
	}
}

export function createOpenaiAppsChallengeHandler(_env: Env) {
	return async () => {
		return new Response(openaiAppsChallengeToken, {
			status: 200,
			headers: discoveryDocumentHeaders('text/plain; charset=utf-8'),
		})
	}
}
