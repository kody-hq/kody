import { readFile, writeFile } from 'node:fs/promises'

/** Watched generated configs must not restart Vite when their contents are unchanged. */
export async function writeGeneratedConfig(path: string, contents: string) {
	try {
		if ((await readFile(path, 'utf8')) === contents) return
	} catch (error) {
		if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
			throw error
	}
	await writeFile(path, contents)
}
