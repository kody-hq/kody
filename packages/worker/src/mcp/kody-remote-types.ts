import type { ResolvedProvider } from '@cloudflare/codemode'

export type KodyRemoteCapabilityMetadata = {
	name: string
	dispatchName: string
}

export type KodyMcpServerMetadata = {
	name: string
	serverId: string
	status: {
		state: string
		connected: boolean
		toolCount: number
		message: string
		unavailableMessage: string
	}
	capabilities: Array<KodyRemoteCapabilityMetadata>
}

export type KodyResolvedProvider = ResolvedProvider & {
	kodyMcpServers?: Array<KodyMcpServerMetadata>
}
