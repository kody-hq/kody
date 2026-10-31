import { expect, test } from 'vitest'
import { http, HttpResponse } from 'msw'
import { createMswNodeServer } from '#worker/test-support/msw-node-server.ts'
import {
	createDrBackupS3Client,
	DrBackupPreconditionFailedError,
	isTransientDrBackupHttpStatus,
	readDrBackupS3Config,
} from './backup-s3.ts'

const config = {
	accountId: 'acct',
	bucketName: 'backups',
	accessKeyId: 'key',
	secretAccessKey: 'secret',
}

const r2Origin = 'https://acct.r2.cloudflarestorage.com'

function drBackupEnv(
	vars: Record<
		| 'DR_BACKUP_ACCOUNT_ID'
		| 'DR_BACKUP_BUCKET_NAME'
		| 'DR_BACKUP_ACCESS_KEY_ID'
		| 'DR_BACKUP_SECRET_ACCESS_KEY',
		string
	>,
) {
	return vars as Parameters<typeof readDrBackupS3Config>[0]
}

test('DR backup S3 client retries transient failures and fails closed otherwise', async () => {
	expect(isTransientDrBackupHttpStatus(429)).toBe(true)
	expect(isTransientDrBackupHttpStatus(500)).toBe(true)
	expect(isTransientDrBackupHttpStatus(503)).toBe(true)
	expect(isTransientDrBackupHttpStatus(400)).toBe(false)
	expect(isTransientDrBackupHttpStatus(412)).toBe(false)

	expect(
		readDrBackupS3Config(
			drBackupEnv({
				DR_BACKUP_ACCOUNT_ID: 'a',
				DR_BACKUP_BUCKET_NAME: 'b',
				DR_BACKUP_ACCESS_KEY_ID: 'c',
				DR_BACKUP_SECRET_ACCESS_KEY: 'd',
			}),
		),
	).toEqual({
		accountId: 'a',
		bucketName: 'b',
		accessKeyId: 'c',
		secretAccessKey: 'd',
	})
	expect(
		readDrBackupS3Config(
			drBackupEnv({
				DR_BACKUP_ACCOUNT_ID: 'a',
				DR_BACKUP_BUCKET_NAME: '',
				DR_BACKUP_ACCESS_KEY_ID: 'c',
				DR_BACKUP_SECRET_ACCESS_KEY: 'd',
			}),
		),
	).toBeNull()

	let progressPuts = 0
	let keyPuts = 0
	let headAttempts = 0
	let progressGets = 0
	let blobGets = 0
	using _server = createMswNodeServer([
		http.put(`${r2Origin}/backups/staging/day/exporter/progress.json`, () => {
			progressPuts += 1
			if (progressPuts === 1) {
				return new HttpResponse('blip', { status: 500 })
			}
			if (progressPuts === 2) {
				return new HttpResponse('', {
					status: 200,
					headers: { etag: '"etag-1"' },
				})
			}
			return new HttpResponse('conflict', { status: 412 })
		}),
		http.put(`${r2Origin}/backups/key`, () => {
			keyPuts += 1
			if (keyPuts === 1) return HttpResponse.error()
			return new HttpResponse('still bad', { status: 500 })
		}),
		http.head(`${r2Origin}/backups/blob`, () => {
			headAttempts += 1
			if (headAttempts === 1) {
				return new HttpResponse(null, { status: 503 })
			}
			return new HttpResponse(null, {
				status: 200,
				headers: { etag: '"h"' },
			})
		}),
		http.get(`${r2Origin}/backups/progress.json`, () => {
			progressGets += 1
			if (progressGets === 1) {
				return new HttpResponse('busy', { status: 503 })
			}
			return new HttpResponse('{"ok":true}', {
				status: 200,
				headers: { etag: '"g"' },
			})
		}),
		http.get(`${r2Origin}/backups/blob.bin`, () => {
			blobGets += 1
			if (blobGets === 1) {
				return new HttpResponse('busy', { status: 503 })
			}
			return new HttpResponse('abc', {
				status: 200,
				headers: { etag: '"b"' },
			})
		}),
	])

	const putClient = createDrBackupS3Client(config, {
		maxAttempts: 3,
		baseDelayMs: 1,
	})
	await expect(
		putClient.put('staging/day/exporter/progress.json', '{}', {
			contentType: 'application/json',
			ifMatch: '"prev"',
		}),
	).resolves.toEqual({ etag: '"etag-1"' })
	expect(progressPuts).toBe(2)

	const preconditionClient = createDrBackupS3Client(config, {
		maxAttempts: 4,
		baseDelayMs: 1,
	})
	await expect(
		preconditionClient.put('staging/day/exporter/progress.json', '{}', {
			ifMatch: '"prev"',
		}),
	).rejects.toBeInstanceOf(DrBackupPreconditionFailedError)
	expect(progressPuts).toBe(3)

	const exhaustedClient = createDrBackupS3Client(config, {
		maxAttempts: 3,
		baseDelayMs: 1,
	})
	await expect(exhaustedClient.put('key', 'body')).rejects.toThrow(
		'DR backup PUT failed for key: HTTP 500',
	)
	expect(keyPuts).toBe(3)

	const headClient = createDrBackupS3Client(config, {
		maxAttempts: 2,
		baseDelayMs: 1,
	})
	await expect(headClient.head('blob')).resolves.toEqual({
		exists: true,
		status: 200,
		etag: '"h"',
	})
	expect(headAttempts).toBe(2)

	const getClient = createDrBackupS3Client(config, {
		maxAttempts: 2,
		baseDelayMs: 1,
	})
	await expect(getClient.getText('progress.json')).resolves.toEqual({
		text: '{"ok":true}',
		etag: '"g"',
	})
	expect(progressGets).toBe(2)

	const bytesClient = createDrBackupS3Client(config, {
		maxAttempts: 2,
		baseDelayMs: 1,
	})
	await expect(bytesClient.getBytes('blob.bin')).resolves.toEqual(
		new Uint8Array([97, 98, 99]),
	)
	expect(blobGets).toBe(2)
})

test('DR backup S3 client retries a conditional PUT conflict (409) and reports a lasting one as a precondition failure', async () => {
	let racedPuts = 0
	using _server = createMswNodeServer([
		http.put(`${r2Origin}/backups/raced.tsv`, () => {
			racedPuts += 1
			if (racedPuts === 1) return new HttpResponse('conflict', { status: 409 })
			return new HttpResponse('', { status: 200, headers: { etag: '"r"' } })
		}),
		http.put(`${r2Origin}/backups/stuck.tsv`, () => {
			return new HttpResponse('conflict', { status: 409 })
		}),
		http.put(`${r2Origin}/backups/plain.tsv`, () => {
			return new HttpResponse('conflict', { status: 409 })
		}),
	])
	const client = createDrBackupS3Client(config, {
		maxAttempts: 3,
		baseDelayMs: 1,
	})
	await expect(
		client.put('raced.tsv', 'a', { ifNoneMatch: '*' }),
	).resolves.toEqual({ etag: '"r"' })
	expect(racedPuts).toBe(2)
	await expect(
		client.put('stuck.tsv', 'a', { ifNoneMatch: '*' }),
	).rejects.toBeInstanceOf(DrBackupPreconditionFailedError)
	await expect(client.put('plain.tsv', 'a')).rejects.toThrow(
		'DR backup PUT failed for plain.tsv: HTTP 409',
	)
})
