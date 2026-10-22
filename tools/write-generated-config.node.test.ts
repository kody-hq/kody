import { mkdtemp, readFile, rm, stat, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test } from 'vitest'
import { writeGeneratedConfig } from './write-generated-config.ts'

test('unchanged generated config does not emit another write for Vite to watch', async () => {
	const directory = await mkdtemp(path.join(tmpdir(), 'kody-generated-config-'))
	try {
		const file = path.join(directory, 'wrangler.generated.json')
		await writeGeneratedConfig(file, '{"port":3742}\n')
		const originalTime = new Date('2000-01-01T00:00:00Z')
		await utimes(file, originalTime, originalTime)
		await writeGeneratedConfig(file, '{"port":3742}\n')
		expect((await stat(file)).mtimeMs).toBe(originalTime.getTime())
		await writeGeneratedConfig(file, '{"port":3743}\n')
		expect(await readFile(file, 'utf8')).toBe('{"port":3743}\n')
		expect((await stat(file)).mtimeMs).not.toBe(originalTime.getTime())
		await expect(writeGeneratedConfig(directory, '{}')).rejects.toMatchObject({
			code: 'EISDIR',
		})
	} finally {
		await rm(directory, { recursive: true, force: true })
	}
})
