export type SidebarPreferences = {
	files?: {
		view: 'columns' | 'icons' | 'list' | 'gallery'
		thumbnailSize: number
	}
	mode: 'compact' | 'auto' | 'show'
	explorer: { width: number; hidden: boolean }
	viewport: number
}
export const sidebarDefaults: SidebarPreferences = {
	mode: 'auto',
	explorer: { width: 232, hidden: false },
	viewport: 1440,
}
export const cookieName = 'kody-sidebar'
export function parseSidebarPreferences(cookies: string): SidebarPreferences {
	try {
		const value = cookies
			.split(';')
			.map((part) => part.trim())
			.find((part) => part.startsWith(`${cookieName}=`))
			?.slice(cookieName.length + 1)
		if (!value) return sidebarDefaults
		const parsed = JSON.parse(decodeURIComponent(value))
		return {
			...(parsed.files &&
			['columns', 'icons', 'list', 'gallery'].includes(parsed.files.view)
				? {
						files: {
							view: parsed.files.view,
							thumbnailSize:
								typeof parsed.files.thumbnailSize === 'number' &&
								Number.isFinite(parsed.files.thumbnailSize)
									? Math.max(84, Math.min(220, parsed.files.thumbnailSize))
									: 132,
						},
					}
				: {}),
			mode:
				parsed.mode === 'compact' || parsed.mode === 'show'
					? parsed.mode
					: 'auto',
			explorer: {
				width:
					typeof parsed.explorer?.width === 'number' &&
					Number.isFinite(parsed.explorer.width)
						? Math.max(180, Math.min(360, parsed.explorer.width))
						: 232,
				hidden: parsed.explorer?.hidden === true,
			},
			viewport:
				typeof parsed.viewport === 'number' && Number.isFinite(parsed.viewport)
					? Math.max(0, parsed.viewport)
					: 1440,
		}
	} catch {
		return sidebarDefaults
	}
}
