import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import { buildPublishedSourceManifestSnapshotKvKey } from '#worker/package-runtime/published-runtime-artifacts.ts'
import {
	clearRunRecords,
	exportRunRecords,
} from '#worker/run-records/service.ts'
import {
	enableSubscriptionForOwner,
	ensurePackageSubscriptionTestSchema,
	seedAccount,
} from '#worker/test-support/workers-seed.ts'
import { silenceIncidentalRuntimeWarnings } from '#worker/test-support/incidental-runtime-warnings.ts'
import { ensureUsageRollupsTestSchema } from '#worker/usage/test-schema.ts'
import { handleInboundEmail } from './inbound.ts'
import { mailboxRpc } from './mailbox-client.ts'
import { getOutboundProviderIndexRow } from './outbound-provider-index.ts'
import { createForwardableEmailMessage } from './test-fixtures.ts'
import { ensureEmailTestSchema } from './test-schema.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'

const platformBaseUrl = 'https://kody.example.com'
const platformDomain = 'inbox.kody.example.com'
const inboundTopic = 'email.message.received'
const sharedUserGraphTable =
	/\bemail_(?:threads|messages|attachments|delivery_events)\b/u

function captureD1Sql(db: D1Database) {
	const statements: Array<string> = []
	return {
		statements,
		db: new Proxy(db, {
			get(target, property, receiver) {
				if (property === 'prepare' || property === 'exec') {
					return (sql: string) => {
						statements.push(sql)
						return target[property](sql)
					}
				}
				const value = Reflect.get(target, property, receiver)
				return typeof value === 'function' ? value.bind(target) : value
			},
		}),
	}
}

async function seedSubscribedPackage(input: {
	bundleKv: Map<string, string>
	userId: string
}) {
	const sourceId = `source-${crypto.randomUUID()}`
	const packageId = `package-${crypto.randomUUID()}`
	const now = new Date().toISOString()
	await env.APP_DB.batch([
		env.APP_DB.prepare(
			`INSERT INTO saved_packages (
					id, user_id, name, kody_id, description, tags_json,
					search_text, source_id, has_app, created_at, updated_at
				) VALUES (?, ?, ?, 'mailbox-flow', 'Mailbox flow', '[]',
					NULL, ?, 0, ?, ?)`,
		).bind(
			packageId,
			input.userId,
			`@flow-${crypto.randomUUID().slice(0, 8)}/mailbox-flow`,
			sourceId,
			now,
			now,
		),
		env.APP_DB.prepare(
			`INSERT INTO entity_sources (
					id, user_id, entity_kind, entity_id, repo_id,
					published_commit, indexed_commit, manifest_path,
					source_root, created_at, updated_at
				) VALUES (?, ?, 'package', ?, 'repo-1', 'commit-1', NULL,
					'package.json', '/', ?, ?)`,
		).bind(sourceId, input.userId, packageId, now, now),
	])
	await enableSubscriptionForOwner({
		db: env.APP_DB,
		userId: input.userId,
		packageId,
		topic: inboundTopic,
	})
	const manifest = {
		name: '@flow/mailbox-flow',
		exports: { '.': './src/index.ts' },
		kody: {
			id: 'mailbox-flow',
			description: 'Mailbox flow',
			subscriptions: {
				[inboundTopic]: { handler: './src/on-email.ts' },
			},
		},
	}
	input.bundleKv.set(
		buildPublishedSourceManifestSnapshotKvKey({
			sourceId,
			publishedCommit: 'commit-1',
		}),
		JSON.stringify({
			version: 1,
			sourceId,
			publishedCommit: 'commit-1',
			manifestPath: 'package.json',
			manifestContent: JSON.stringify(manifest),
			createdAt: now,
		}),
	)
	const artifactKey = `bundle-artifact:v1:${sourceId}:commit-1:module:subscription:${inboundTopic}:src/on-email.ts`
	input.bundleKv.set(
		artifactKey,
		JSON.stringify({
			version: 1,
			kind: 'module',
			artifactName: `subscription:${inboundTopic}`,
			sourceId,
			publishedCommit: 'commit-1',
			entryPoint: 'src/on-email.ts',
			mainModule: 'dist/subscription.js',
			modules: {
				'.__kody_virtual__/runtime.js': `
import { AsyncLocalStorage } from 'node:async_hooks';
const __kodyRuntimeStorageSymbol = Symbol.for('kody.runtimeStorage');
const __kodyGlobal = globalThis;
const __kodyRuntimeStorage =
  __kodyGlobal[__kodyRuntimeStorageSymbol] ??
  (__kodyGlobal[__kodyRuntimeStorageSymbol] = new AsyncLocalStorage());
const runtime = __kodyRuntimeStorage.getStore() ?? {};
export const kody = runtime.kody;
export const email = runtime.email ?? null;
`.trim(),
				'dist/subscription.js': `
import { email } from '../.__kody_virtual__/runtime.js'

export default async function main(input = {}) {
	const message = await email.getMessage(input.message.id)
	const firstAttachment = Array.isArray(input.attachments)
		? input.attachments[0]
		: null
	const attachment = firstAttachment?.id
		? await email.getAttachment(firstAttachment.id)
		: null
	const attachmentText = attachment?.content_base64
		? atob(attachment.content_base64)
		: null
	const reply = await email.reply({
		message_id: input.message.id,
		text: 'Thanks for the note.',
	})
	return {
		event: input.event,
		messageId: message.id,
		subject: message.subject,
		textBody: message.text_body,
		attachmentText,
		replyMessageId: reply.id,
		replyDirection: reply.direction,
	}
}
`,
			},
			dependencies: [],
			packageContext: {
				packageId,
				kodyId: 'mailbox-flow',
				sourceId,
			},
			createdAt: now,
		}),
	)
	await env.APP_DB.prepare(
		`INSERT INTO published_bundle_artifacts (
				id, user_id, source_id, published_commit, artifact_kind,
				artifact_name, entry_point, kv_key, dependencies_json,
				created_at, updated_at
			) VALUES (?, ?, ?, 'commit-1', 'module', ?,
				'src/on-email.ts', ?, '[]', ?, ?)`,
	)
		.bind(
			`artifact-${crypto.randomUUID()}`,
			input.userId,
			sourceId,
			`subscription:${inboundTopic}`,
			artifactKey,
			now,
			now,
		)
		.run()
	return packageId
}

function bundleArtifactsKv(bundleKv: Map<string, string>) {
	return {
		async get(key: string, type?: string) {
			const value = bundleKv.get(key) ?? null
			if (value == null) return null
			if (type === 'json') return JSON.parse(value) as unknown
			return value
		},
		async put() {},
		async delete() {},
	} as unknown as KVNamespace
}

test('USER inbound attachment, package event, reply, and provider index stay Mailbox-authoritative', async () => {
	silenceIncidentalRuntimeWarnings()
	await ensureEmailTestSchema(env.APP_DB)
	await ensureUsageRollupsTestSchema(env.APP_DB)
	await ensurePackageSubscriptionTestSchema(env.APP_DB)
	const username = `mailbox-flow-${crypto.randomUUID().slice(0, 8)}`
	const accountEmail = `${username}@example.com`
	const userId = testStableUserIdFromEmail(accountEmail)
	await seedAccount({
		db: env.APP_DB,
		email: accountEmail,
		username,
		plan: 'max',
		stableUserId: userId,
	})
	await clearRunRecords({ env, userId: ownerIdFromStored(userId) })
	const bundleKv = new Map<string, string>()
	const packageId = await seedSubscribedPackage({ bundleKv, userId })
	const captured = captureD1Sql(env.APP_DB)
	const providerMessageId = `provider-${crypto.randomUUID()}`
	const sent: Array<Record<string, unknown>> = []
	const flowEnv = {
		...env,
		APP_DB: captured.db,
		APP_BASE_URL: platformBaseUrl,
		BUNDLE_ARTIFACTS_KV: bundleArtifactsKv(bundleKv),
		EMAIL: {
			async send(message: Record<string, unknown>) {
				sent.push(message)
				return { messageId: providerMessageId }
			},
		} as unknown as SendEmail,
	}
	const waitUntilPromises: Array<Promise<unknown>> = []
	const ctx = {
		waitUntil(promise: Promise<unknown>) {
			waitUntilPromises.push(promise)
		},
		passThroughOnException() {},
	} as ExecutionContext
	const address = `${username}@${platformDomain}`
	const inbound = createForwardableEmailMessage({
		from: 'sender@example.net',
		to: address,
		raw: [
			'From: Sender <sender@example.net>',
			`To: ${address}`,
			'Subject: Integrated Mailbox flow',
			`Message-ID: <flow-${crypto.randomUUID()}@example.net>`,
			'Authentication-Results: mx.cloudflare.net; spf=pass; dkim=pass; dmarc=pass',
			'Content-Type: multipart/mixed; boundary="mailbox-flow-boundary"',
			'',
			'--mailbox-flow-boundary',
			'Content-Type: text/plain; charset="utf-8"',
			'',
			'Please reply.',
			'--mailbox-flow-boundary',
			'Content-Type: text/plain; name="note.txt"',
			'Content-Disposition: attachment; filename="note.txt"',
			'',
			'Attachment bytes.',
			'--mailbox-flow-boundary--',
		].join('\r\n'),
	})

	await handleInboundEmail(inbound, flowEnv, ctx)
	for (const promise of waitUntilPromises) await promise
	expect(inbound.rejectedReason).toBeNull()

	const mailbox = mailboxRpc({ env, userId: ownerIdFromStored(userId) })
	const inboundPage = await mailbox.listMessages({
		direction: 'inbound',
		limit: 10,
	})
	expect(inboundPage.messages).toHaveLength(1)
	const inboundMessage = inboundPage.messages[0]
	if (!inboundMessage) throw new Error('Expected inbound Mailbox message.')
	expect(inboundMessage).toMatchObject({
		subject: 'Integrated Mailbox flow',
		processingStatus: 'stored',
	})
	await expect(
		mailbox.listAttachmentsForMessage({ messageId: inboundMessage.id }),
	).resolves.toEqual([
		expect.objectContaining({
			filename: 'note.txt',
			storageKind: 'raw-mime',
		}),
	])

	const invocations = (
		await exportRunRecords({
			env: flowEnv,
			userId: ownerIdFromStored(userId),
			pageSize: 100,
		})
	).packageInvocations
	expect(invocations).toHaveLength(1)
	expect(invocations[0]).toMatchObject({
		packageId,
		topic: inboundTopic,
		source: 'email',
	})
	const responseJson = invocations[0]?.responseJson
	if (!responseJson) throw new Error('Expected package sandbox response.')
	expect(
		JSON.parse(responseJson) as {
			body: { result: Record<string, unknown> }
		},
	).toMatchObject({
		body: {
			result: {
				event: inboundTopic,
				messageId: inboundMessage.id,
				subject: 'Integrated Mailbox flow',
				textBody: 'Please reply.',
				attachmentText: 'Attachment bytes.',
				replyMessageId: expect.any(String),
				replyDirection: 'outbound',
			},
		},
	})

	const outboundPage = await mailbox.listMessages({
		direction: 'outbound',
		limit: 10,
	})
	expect(outboundPage.messages).toHaveLength(1)
	const reply = outboundPage.messages[0]
	if (!reply) throw new Error('Expected package-triggered Mailbox reply.')
	expect(sent).toHaveLength(1)
	expect(sent[0]).toMatchObject({ to: 'sender@example.net' })
	expect(reply).toMatchObject({
		direction: 'outbound',
		processingStatus: 'sent',
		providerMessageId,
		inReplyToHeader: inboundMessage.messageIdHeader,
	})
	await expect(
		getOutboundProviderIndexRow({
			db: captured.db,
			providerMessageId,
		}),
	).resolves.toMatchObject({
		userId,
		messageId: reply.id,
	})
	expect(
		captured.statements.filter((sql) => sharedUserGraphTable.test(sql)),
	).toEqual([])
}, 60_000)
