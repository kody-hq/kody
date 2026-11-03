import { readFileSync } from 'node:fs'
import type { Plugin } from 'vite'

/**
 * Load `.md` files as default-exported strings so vitest/node can import the
 * same modules Wrangler bundles via Text module rules for markdown globs.
 */
export function markdownAsText(): Plugin {
	return {
		name: 'markdown-as-text',
		enforce: 'pre',
		load(id) {
			const filePath = id.split('?')[0] ?? id
			if (!filePath.endsWith('.md')) return null
			const source = readFileSync(filePath, 'utf8')
			return `export default ${JSON.stringify(source)}`
		},
	}
}
