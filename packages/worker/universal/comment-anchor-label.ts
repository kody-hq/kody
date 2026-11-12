import { videoTime, type CommentAnchor } from './file-collaboration.ts'

export function commentAnchorLabel(anchor: CommentAnchor): string {
	switch (anchor.kind) {
		case 'video':
		case 'audio':
			return videoTime(anchor.timeMs, true)
		case 'image':
			return 'Image pin'
		case 'json':
			return anchor.pointer || 'JSON root'
		case 'csv':
			return anchor.row === 0
				? `Header, column ${anchor.column + 1}`
				: `Row ${anchor.row + 1}, column ${anchor.column + 1}`
		case 'block':
		case 'text':
			return anchor.quote || 'Selected block'
		case 'file':
			return 'File'
	}
}
