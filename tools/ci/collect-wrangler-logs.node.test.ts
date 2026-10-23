import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import {
	collectWranglerLogs,
	parseSecretValues,
} from './collect-wrangler-logs.ts'

test('copies clean logs and drops logs that contain a secret value', async () => {
	const root = await mkdtemp(join(tmpdir(), 'wrangler-logs-'))
	try {
		const from = join(root, 'logs')
		const out = join(root, 'out')
		await import('node:fs/promises').then((fs) => fs.mkdir(from))
		await writeFile(
			join(from, 'clean.log'),
			'Uploaded kody-production\nAn unknown error has occurred. [code: 10013]\n',
		)
		await writeFile(
			join(from, 'leaky.log'),
			'debug value fake-secret-value-123 here\n',
		)
		await writeFile(
			join(from, 'bearer.log'),
			'Bearer abcdefghijklmnopqrstuvwxyz0123\n',
		)
		const result = collectWranglerLogs({
			from,
			out,
			secretsJson: JSON.stringify({
				CLOUDFLARE_API_TOKEN: 'fake-secret-value-123',
				SHORT: 'abc',
			}),
		})
		expect(result.copied).toEqual(['clean.log'])
		expect(result.dropped.sort()).toEqual(['bearer.log', 'leaky.log'])
		expect(await readdir(out)).toEqual(['clean.log'])
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})

test('fails closed without secret input', () => {
	const result = collectWranglerLogs({
		from: '/nonexistent',
		out: '/nonexistent-out',
		secretsJson: undefined,
	})
	expect(result.copied).toEqual([])
	expect(result.reason).toContain('copied nothing')
})

test('parseSecretValues covers each line of multi-line values', () => {
	const needles = parseSecretValues(
		JSON.stringify({
			PEM: '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0B\n-----END PRIVATE KEY-----',
		}),
	)
	expect(needles?.has('MIIEvQIBADANBgkqhkiG9w0B')).toBe(true)
})
