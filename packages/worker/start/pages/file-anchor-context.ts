import { createContext } from 'react'
import type {
	CommentAnchor,
	FileThread,
} from '#universal/file-collaboration.ts'

export const FileAnchorContext = createContext<{
	threads: FileThread[]
	activeId: string | null
	revisionId: string
	onSelect: (thread: FileThread) => void
	onComment?: (anchor: CommentAnchor) => void
} | null>(null)
