/** @jsxImportSource @emotion/react */
import { useCallback, useRef, useState } from 'react'
import { useResourceLifetime } from '../lib/primitives.ts'
import peleScriptUrl from 'pele/global?url'

function diagramDocument(nonce: string, origin: string, scriptUrl: string) {
	// Only application code and the bundled Pele script may run in the frame.
	const policy = [
		"default-src 'none'",
		`script-src 'nonce-${nonce}'`,
		"style-src 'unsafe-inline'",
		'img-src data:',
		'font-src data:',
		"base-uri 'none'",
		"form-action 'none'",
	].join('; ')
	return `<!doctype html><html><head><meta charset="utf-8">
		<meta http-equiv="Content-Security-Policy" content="${policy}">
		<style>body{margin:0;padding:8px;font-family:system-ui;color:#222;background:white}
		svg{display:block;max-width:100%;height:auto}</style></head>
		<body><div id="diagram"></div>
		<script nonce="${nonce}" src="${scriptUrl.replaceAll('&', '&amp;').replaceAll('"', '&quot;')}"></script>
		<script nonce="${nonce}">
		const origin = ${JSON.stringify(origin)};
		const root = document.getElementById('diagram');
		const report = () => parent.postMessage({type:'kody-mermaid-size',height:document.body.scrollHeight}, origin);
		addEventListener('message', (event) => {
			if (event.source !== parent || event.origin !== origin ||
			    event.data?.type !== 'kody-mermaid-source' || typeof event.data.source !== 'string') return;
			try {
				if (typeof pele === 'undefined') throw new Error('Pele is unavailable');
				const {svg} = pele.render(event.data.source, {
					limit: 16000, maxEdges: 400, outputLimit: 1000000, links: false, images: false
				});
				root.innerHTML = svg;
			} catch {
				root.textContent = typeof pele === 'undefined' ? 'Could not load the diagram renderer.' : 'Could not render Mermaid source.';
			}
			report();
		});
		new ResizeObserver(report).observe(root);
		</script></body></html>`
}

export default function WorkspaceMermaid({ source }: { source: string }) {
	const frame = useRef<HTMLIFrameElement>(null)
	const [height, setHeight] = useState(48)
	const sendSource = useCallback(() => {
		frame.current?.contentWindow?.postMessage(
			{ type: 'kody-mermaid-source', source },
			'*',
		)
	}, [source])
	const frameRef = useCallback((target: HTMLIFrameElement | null) => {
		frame.current = target
		if (!target) return
		function resize(event: MessageEvent) {
			if (
				event.source === target?.contentWindow &&
				event.origin === 'null' &&
				event.data?.type === 'kody-mermaid-size' &&
				Number.isFinite(event.data.height)
			)
				setHeight(Math.min(600, Math.max(48, event.data.height + 2)))
		}
		window.addEventListener('message', resize)
		const nonce =
			document.querySelector<HTMLMetaElement>('meta[property="csp-nonce"]')
				?.content || crypto.randomUUID()
		target.srcdoc = diagramDocument(
			nonce,
			location.origin,
			new URL(peleScriptUrl, location.href).href,
		)
		return () => {
			frame.current = null
			window.removeEventListener('message', resize)
		}
	}, [])
	useResourceLifetime(() => {
		const timer = window.setTimeout(sendSource, 250)
		return () => window.clearTimeout(timer)
	}, [sendSource])
	return (
		<iframe
			ref={frameRef}
			onLoad={sendSource}
			title="Mermaid diagram"
			loading="lazy"
			sandbox="allow-scripts"
			referrerPolicy="no-referrer"
			css={{
				display: 'block',
				width: '100%',
				height,
				border: 0,
				background: 'white',
				borderRadius: 6,
			}}
		/>
	)
}
