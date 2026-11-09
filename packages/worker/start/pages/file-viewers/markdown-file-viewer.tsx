import { renderMarkdownNodes } from '../../components/markdown-view.tsx'
export default function MarkdownFileViewer({ content }: { content: string }) {
	return renderMarkdownNodes(content, { headingOffset: 0 })
}
