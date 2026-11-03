import type { McpServerUsageMode } from './usage-mode.ts'

export type McpServerLogoSource = 'favicon'

export type McpServerSettingRow = {
	id: string
	user_id: string
	name: string
	url: string
	enabled: boolean
	created_at: string
	updated_at: string
	logo_key: string | null
	logo_content_type: string | null
	logo_source: McpServerLogoSource | null
	favicon_source_host: string | null
	usage_mode: McpServerUsageMode
	allowedPackageIds: Array<string>
	last_error: string | null
}

export type McpServerSettingMetadata = {
	id: string
	name: string
	url: string
	enabled: boolean
	createdAt: string
	updatedAt: string
	logoKey: string | null
	logoContentType: string | null
	logoSource: McpServerLogoSource | null
	faviconSourceHost: string | null
	usageMode: McpServerUsageMode
	allowedPackageIds: Array<string>
	lastError: string | null
}
