/** @jsxImportSource @emotion/react */
import { useRef, useLayoutEffect } from 'react'
import { colors } from '#universal/styles/tokens.ts'
import { htmlPreviewPath } from '#universal/html-preview.ts'
export function HtmlPreview({
	content,
	orgSlug,
	inline,
	fill,
}: {
	content: string
	orgSlug: string
	inline: boolean
	fill: boolean
}) {
	const frame = useRef<HTMLIFrameElement>(null)
	const sendContent = () =>
		frame.current?.contentWindow?.postMessage(
			{ type: 'kody-html-preview', content },
			'*',
		)
	useLayoutEffect(sendContent, [content])

	return (
		<>
			<iframe
				ref={frame}
				src={htmlPreviewPath(orgSlug)}
				onLoad={sendContent}
				title="HTML preview"
				sandbox="allow-scripts"
				referrerPolicy="no-referrer"
				css={{
					width: '100%',
					display: 'block',
					minHeight: fill ? 0 : inline ? 230 : '55vh',
					flex: fill ? 1 : undefined,
					height: fill ? '100%' : undefined,
					boxSizing: 'border-box',
					border: fill ? 0 : `1px solid ${colors.border}`,
					borderRadius: fill ? 0 : 8,
					background: 'white',
				}}
			/>
		</>
	)
}
