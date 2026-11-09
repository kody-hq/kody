export type FileViewerKind =
	| 'image'
	| 'pdf'
	| 'video'
	| 'audio'
	| 'docx'
	| 'xlsx'
	| 'pptx'
	| 'zip'
	| 'json'
export function fileViewerKind(
	name: string,
	mediaType: string,
): FileViewerKind | null {
	mediaType = detectFileMediaType(name, mediaType)
	if (mediaType === workspacePageMediaType) return null
	if (mediaType === 'application/json' || mediaType.endsWith('+json'))
		return 'json'
	if (/^image\/(png|jpeg|gif|webp|avif|svg\+xml)$/.test(mediaType))
		return 'image'
	if (
		mediaType === 'application/zip' ||
		mediaType === 'application/x-zip-compressed'
	)
		return 'zip'
	if (mediaType === 'application/pdf') return 'pdf'
	if (mediaType.startsWith('video/')) return 'video'
	if (mediaType.startsWith('audio/')) return 'audio'
	const office: Record<string, FileViewerKind> = {
		'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
			'docx',
		'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
		'application/vnd.openxmlformats-officedocument.presentationml.presentation':
			'pptx',
	}
	if (office[mediaType]) return office[mediaType]!
	const extension = name.toLowerCase().split('.').at(-1)
	if (extension === 'docx' || extension === 'xlsx' || extension === 'pptx')
		return extension
	if (extension === 'zip') return 'zip'
	if (extension === 'pdf') return 'pdf'
	if (extension === 'svg') return 'image'
	return null
}

export function detectFileMediaType(name: string, mediaType: string) {
	const extension = name.toLowerCase().split('.').at(-1) ?? ''
	const known: Record<string, string> = {
		md: 'text/markdown',
		markdown: 'text/markdown',
		html: 'text/html',
		htm: 'text/html',
		csv: 'text/csv',
		json: 'application/json',
		zip: 'application/zip',
		pdf: 'application/pdf',
		png: 'image/png',
		jpg: 'image/jpeg',
		jpeg: 'image/jpeg',
		gif: 'image/gif',
		webp: 'image/webp',
		avif: 'image/avif',
		svg: 'image/svg+xml',
		docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
		xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
		pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
		mp4: 'video/mp4',
		webm: 'video/webm',
		mov: 'video/quicktime',
		mp3: 'audio/mpeg',
		wav: 'audio/wav',
		ogg: 'audio/ogg',
		m4a: 'audio/mp4',
	}
	return ['md', 'markdown', 'html', 'htm', 'csv', 'json'].includes(extension) ||
		!mediaType ||
		mediaType === 'application/octet-stream'
		? known[extension] || mediaType || 'application/octet-stream'
		: mediaType
}
import { workspacePageMediaType } from './workspace-page.ts'
