/** Avoid a Cloudflare Assets canonicalization redirect for route punctuation. */
export function startChunkFileNames(chunk: { name: string }) {
	return `assets/${chunk.name.replace(/[^a-zA-Z0-9._-]/g, '_')}-[hash].js`
}
