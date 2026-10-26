import { DatabaseSync } from 'node:sqlite'
import {
	mintApiToken,
	apiTokenLifetimeAliases,
} from '#worker/api-tokens/service.ts'
import { cliClientIdMetadataPath } from '#worker/cli-client-metadata.ts'
import { handleOpenApiRequest } from '#worker/open-api/http-handler.ts'
import { provisionPersonalOrg } from '#worker/orgs/provision.ts'
import { applyAllMigrations } from './apply-all-migrations.ts'
import { createAuditTestDb } from './create-audit-db.ts'
import { createD1FromSqlite } from './create-d1-from-sqlite.ts'
import { testStableUserIdFromEmail } from './stable-user-id.ts'
import { createInMemoryUserMeterEnv } from './user-meter.ts'

export type OpenApiTestResponseBody = Record<string, unknown> & {
	error?: { code: string; message: string; details?: unknown }
}

const migrationsDirectory = new URL('../../migrations/', import.meta.url)
export const openApiTestApiOrigin = 'https://api.kody.test'
export const openApiTestAppOrigin = 'https://kody.test'

/**
 * In-memory D1 + UserMeter Open API harness: one verified user with a
 * personal org, token minting, and `handleOpenApiRequest` calls.
 */
export async function createOpenApiTestHarness(
	input: {
		emailVerified?: boolean
		suspended?: boolean
		oauthAccessToken?: string | null
		oauthAudience?: string | Array<string>
		oauthClientId?: string
		oauthExpiresAtUnix?: number
		oauthUnwrapFails?: boolean
		captureUsage?: Array<{
			blobs: Array<string | null | undefined>
			indexes?: Array<string | null | undefined>
		}>
	} = {},
) {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, migrationsDirectory)
	const email = 'api-user@example.com'
	const userId = testStableUserIdFromEmail(email)
	sqlite
		.prepare(
			`INSERT INTO users (id, username, email, password_hash, stable_user_id, email_verified_at, suspended_at)
			 VALUES (1, 'api-user', ?, 'hash', ?, ?, ?)`,
		)
		.run(
			email,
			userId,
			input.emailVerified === false ? null : '2026-01-01T00:00:00.000Z',
			input.suspended ? '2026-01-01T00:00:00.000Z' : null,
		)
	const db = createD1FromSqlite(sqlite)
	await provisionPersonalOrg(db, {
		stableUserId: userId,
		username: 'api-user',
	})
	const oauthAccessToken = input.oauthAccessToken
	const userMeter = createInMemoryUserMeterEnv()
	const oauthExpiresAtUnix =
		input.oauthExpiresAtUnix ?? Math.floor(Date.now() / 1000) + 3600
	const env = {
		APP_DB: db,
		AUDIT_DB: createAuditTestDb(),
		COOKIE_SECRET: 'test-cookie-secret',
		SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum',
		...userMeter.env,
		...(oauthAccessToken !== undefined
			? {
					OAUTH_PROVIDER: {
						async unwrapToken(token: string) {
							if (input.oauthUnwrapFails) return null
							if (token !== oauthAccessToken) return null
							return {
								createdAt: Math.floor(Date.now() / 1000) - 60,
								expiresAt: oauthExpiresAtUnix,
								audience: input.oauthAudience ?? openApiTestAppOrigin,
								scope: ['openid', 'profile', 'email'],
								grant: {
									clientId:
										input.oauthClientId ??
										`${openApiTestAppOrigin}${cliClientIdMetadataPath}`,
									scope: ['openid', 'profile', 'email'],
									props: {
										userId,
										email,
										username: 'api-user',
										displayName: 'API User',
										authTime: Math.floor(Date.now() / 1000) - 60,
									},
								},
							}
						},
					},
				}
			: {}),
		...(input.captureUsage
			? {
					USAGE_EVENTS: {
						writeDataPoint(point?: {
							blobs?: Array<string | null | undefined>
							indexes?: Array<string | null | undefined>
						}) {
							input.captureUsage?.push({
								blobs: point?.blobs ?? [],
								indexes: point?.indexes,
							})
						},
					},
				}
			: {}),
	} as unknown as Env
	const pending: Array<Promise<unknown>> = []
	async function call(
		method: string,
		path: string,
		options: {
			token?: string
			body?: unknown
			contentType?: string
			headers?: Record<string, string>
		} = {},
	) {
		const headers = new Headers(options.headers)
		if (options.token) headers.set('Authorization', `Bearer ${options.token}`)
		if (options.body !== undefined) {
			headers.set('Content-Type', options.contentType ?? 'application/json')
		}
		const response = await handleOpenApiRequest({
			request: new Request(`${openApiTestApiOrigin}${path}`, {
				method,
				headers,
				...(options.body === undefined
					? {}
					: {
							body:
								typeof options.body === 'string'
									? options.body
									: JSON.stringify(options.body),
						}),
			}),
			env,
			appOrigin: openApiTestAppOrigin,
			waitUntil: (promise) => pending.push(promise),
		})
		await Promise.all(pending.splice(0))
		return {
			status: response.status,
			headers: response.headers,
			body: (response.status === 304
				? null
				: await response.json()) as OpenApiTestResponseBody,
		}
	}
	async function mint(scopes: Array<string>) {
		const minted = await mintApiToken({
			db,
			userId,
			name: 'test',
			scopes,
			idleTtlSeconds: apiTokenLifetimeAliases.short.idleTtlSeconds,
			maxLifetimeSeconds: apiTokenLifetimeAliases.short.maxLifetimeSeconds,
			createdVia: 'api',
		})
		return minted.token
	}
	return { sqlite, db, env, userId, userMeter, call, mint, oauthAccessToken }
}
