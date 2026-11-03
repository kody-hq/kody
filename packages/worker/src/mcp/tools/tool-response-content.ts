import type { ContentBlock } from '@modelcontextprotocol/sdk/types.js'

export function prependToolMetadataContent(
	conversationId: string,
	content: Array<ContentBlock> | undefined,
) {
	const metadataBlock: ContentBlock = {
		type: 'text',
		text: `conversationId: ${conversationId}`,
	}
	if (!content || content.length === 0) return [metadataBlock]
	return [metadataBlock, ...content]
}

export function appendToolContent(
	content: Array<ContentBlock> | undefined,
	extraContent: Array<ContentBlock> | undefined,
) {
	if (!content || content.length === 0) return extraContent ?? []
	if (!extraContent || extraContent.length === 0) return content
	return [...content, ...extraContent]
}
