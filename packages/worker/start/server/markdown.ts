import { prefersMarkdown, markdownResponse } from '#app/markdown-negotiation.ts'
import {
	buildHomeMarkdown,
	withAgentDiscoveryLinkHeaders,
} from '#app/agent-discovery.ts'
import { getAppBaseUrl } from '#worker/app-base-url.ts'
import { renderAcquisitionMarkdown } from '#app/acquisition-markdown.ts'
import { env } from 'cloudflare:workers'
import { getEnv } from '#app/env.ts'
import {
	docsMarkdownHttp,
	docsConnectMarkdownHttp,
	docDetailMarkdownHttp,
	blogPostMarkdownHttp,
} from './protocol-handlers.ts'

type Input = {
	request: Request
	params: Record<string, string>
	next: () => { isNext: true; context: undefined }
}
export function homeMarkdown(input: Input) {
	if (!prefersMarkdown(input.request)) return input.next()
	const origin = getAppBaseUrl({
		env: getEnv(env),
		requestUrl: input.request.url,
	})
	return withAgentDiscoveryLinkHeaders(
		markdownResponse(buildHomeMarkdown(origin)),
		origin,
	)
}
export function acquisitionMarkdown(input: Input) {
	return prefersMarkdown(input.request)
		? renderAcquisitionMarkdown(input.request)
		: input.next()
}
export function docsMarkdown(input: Input) {
	return prefersMarkdown(input.request) ? docsMarkdownHttp(input) : input.next()
}
export function docsConnectMarkdown(input: Input) {
	return prefersMarkdown(input.request)
		? docsConnectMarkdownHttp(input)
		: input.next()
}
export function docMarkdown(input: Input & { params: { slug: string } }) {
	return prefersMarkdown(input.request)
		? docDetailMarkdownHttp(input)
		: input.next()
}
export function blogMarkdown(input: Input & { params: { slug: string } }) {
	return prefersMarkdown(input.request)
		? blogPostMarkdownHttp(input)
		: input.next()
}
