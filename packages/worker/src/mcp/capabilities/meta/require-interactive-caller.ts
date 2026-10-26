import { McpCallerError } from '#mcp/caller-error.ts'

export function requireInteractiveMcpCaller(
	callerContext: {
		executionOrigin?: string
		storageContext?: {
			packageId?: string | null
			appId?: string | null
			storageId?: string | null
		} | null
	},
	message: string,
): void {
	if (callerContext.executionOrigin !== 'interactive') {
		throw new McpCallerError(message)
	}
	const storageContext = callerContext.storageContext
	const packageId = storageContext?.packageId?.trim() ?? ''
	const appId = storageContext?.appId?.trim() ?? ''
	const storageId = storageContext?.storageId?.trim() ?? ''
	if (packageId || appId || storageId) {
		throw new McpCallerError(message)
	}
}
