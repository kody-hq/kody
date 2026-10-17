import { readFile } from 'node:fs/promises'
import { transform } from 'esbuild'
import { type Plugin } from 'vite'

export async function minifyInlineCss(source: string) {
	// CSS input preprocessing treats CRLF as one newline, including after escapes.
	const { code } = await transform(source.replace(/\r\n?|\f/g, '\n'), {
		loader: 'css',
		minify: true,
	})
	return code
}

/** Minify inline CSS at build time without rewriting public asset URLs. */
export function inlineCssText(): Plugin {
	return {
		name: 'inline-css-text',
		apply: 'build',
		enforce: 'pre',
		async load(id) {
			if (!id.endsWith('.css?raw')) return null
			const filePath = id.slice(0, -'?raw'.length)
			this.addWatchFile(filePath)
			const code = await minifyInlineCss(await readFile(filePath, 'utf8'))
			return `export default ${JSON.stringify(code)}`
		},
	}
}
