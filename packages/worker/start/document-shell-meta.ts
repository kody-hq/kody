/** Shared by the rendered shell and its value-free hydration diagnostics. */
export const documentCharset = 'utf-8'
export const documentViewport = 'width=device-width, initial-scale=1'
export const documentThemeColors = {
	light: { content: '#e6e8ea', media: '(prefers-color-scheme: light)' },
	dark: { content: '#111417', media: '(prefers-color-scheme: dark)' },
} as const
