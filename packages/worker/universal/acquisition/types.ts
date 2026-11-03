import type { acquisitionPageMeta } from './metadata.ts'

export type AcquisitionPage = {
	key: string
	path: string
	title: string
	description: string
	lead: string
	flow: Array<string>
	sections: Array<{
		title: string
		paragraphs: Array<string>
		steps?: Array<string>
		table?: { headers: Array<string>; rows: Array<Array<string>> }
		code?: string
	}>
	prompt: string
	sources: Array<{ label: string; href: string }>
	related: Array<keyof typeof acquisitionPageMeta>
}
