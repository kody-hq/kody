import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { expect, test, vi } from 'vitest'

import { buildVerificationQueries, verifyRows } from './d1-restore-drill.ts'
import {
	buildD1RestoreWranglerConfig,
	createD1DrillTarget,
	parseQueryRows,
	runProcess,
} from './d1-restore-drill-cli.ts'
import {
	createBaseline,
	now,
	targetAccountId,
	targetUuid,
} from './disaster-recovery-test-support.ts'

test('real local Wrangler returns quick_check rows through the production parser', async () => {
	const directory = await mkdtemp(
		path.join(os.tmpdir(), 'd1-restore-contract-'),
	)
	try {
		const configPath = path.join(directory, 'wrangler.json')
		const migrationsDirectory = path.join(directory, 'migrations')
		const persistDirectory = path.join(directory, 'state')
		await mkdir(migrationsDirectory)
		await writeFile(
			path.join(migrationsDirectory, '0001-contract-check.sql'),
			'CREATE TABLE contract_check (id INTEGER PRIMARY KEY);\n',
		)
		await writeFile(
			configPath,
			JSON.stringify(
				buildD1RestoreWranglerConfig({
					configPath,
					migrationsDirectory,
					targetName: 'restore-contract',
					targetUuid,
				}),
			),
		)
		const cleanEnvironment = {
			HOME: process.env.HOME,
			PATH: process.env.PATH,
			TMPDIR: process.env.TMPDIR,
		}
		await runProcess(
			{
				kind: 'migration',
				program: 'wrangler',
				args: [
					'd1',
					'migrations',
					'apply',
					'D1_RESTORE_TARGET',
					'--local',
					'--config',
					configPath,
					'--persist-to',
					persistDirectory,
				],
			},
			cleanEnvironment,
			false,
		)
		const query = buildVerificationQueries(createBaseline(), 'baseline')[0]
		if (!query) throw new Error('fixture lacks quick_check query')
		const output = await runProcess(
			{
				kind: 'verification',
				phase: query.phase,
				program: 'wrangler',
				args: [
					'd1',
					'execute',
					'D1_RESTORE_TARGET',
					'--local',
					'--config',
					configPath,
					'--persist-to',
					persistDirectory,
					'--json',
					'--command',
					query.sql,
				],
			},
			cleanEnvironment,
			false,
		)
		const rows = parseQueryRows(output)
		expect(rows).toEqual([{ quick_check: 'ok' }])
		expect(() => verifyRows(query, rows, createBaseline())).not.toThrow()
		expect(() =>
			verifyRows(query, [{ integrity_check: 'ok' }], createBaseline()),
		).toThrow('PRAGMA quick_check failed')
		expect(() =>
			verifyRows(query, [{ QUICK_CHECK: 'OK' }], createBaseline()),
		).not.toThrow()
	} finally {
		await rm(directory, { recursive: true, force: true })
	}
	// Two real Wrangler/workerd cold starts run alongside the rest of the Node
	// shard on CI. Keep a bounded integration-test budget for both processes.
}, 120_000)

test('Cloudflare create adapter uses documented endpoint and validates response envelope', async () => {
	const fetcher = vi.fn(async () => {
		return new Response(
			JSON.stringify({
				success: true,
				result: {
					uuid: targetUuid,
					name: 'kody-drill',
					created_at: now.toISOString(),
				},
			}),
			{ status: 200, headers: { 'Content-Type': 'application/json' } },
		)
	})
	await expect(
		createD1DrillTarget({
			accountId: targetAccountId,
			name: 'kody-drill',
			token: 'drill-only-token',
			fetcher,
			apiBaseUrl: 'https://api.example.test/client/v4',
		}),
	).resolves.toEqual({
		uuid: targetUuid,
		name: 'kody-drill',
		createdAt: now.toISOString(),
	})
	expect(fetcher).toHaveBeenCalledWith(
		`https://api.example.test/client/v4/accounts/${targetAccountId}/d1/database`,
		expect.objectContaining({
			method: 'POST',
			body: JSON.stringify({ name: 'kody-drill' }),
		}),
	)
})
