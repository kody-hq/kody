import { readFile } from 'node:fs/promises'
import { expect, test } from 'vitest'
import { resolveEmailSendingEventSubscriptionDomains } from './production-resources.ts'
import { parseJsonc } from './resource-utils.ts'

const executeWorkerConfigPaths = [
	'packages/worker/wrangler.jsonc',
	'packages/platform-worker/wrangler.jsonc',
] as const

test('origin and platform bind execute interpretable telemetry in production and preview', async () => {
	for (const configPath of executeWorkerConfigPaths) {
		const config = parseJsonc<{
			env?: Record<
				string,
				{
					analytics_engine_datasets?: Array<{
						binding?: string
						dataset?: string
					}>
				}
			>
		}>(await readFile(configPath, 'utf8'))
		for (const envName of ['production', 'preview'] as const) {
			const binding = config.env?.[envName]?.analytics_engine_datasets?.find(
				(entry) => entry.binding === 'EXECUTE_INTERPRETABLE_EVENTS',
			)
			const expectedDataset =
				envName === 'production'
					? 'kody_execute_interpretable_events'
					: 'kody_execute_interpretable_events_preview'
			expect(binding, `${configPath} env.${envName}`).toEqual({
				binding: 'EXECUTE_INTERPRETABLE_EVENTS',
				dataset: expectedDataset,
			})
		}
	}
})

const searchWorkerConfigPaths = [
	'packages/worker/wrangler.jsonc',
	'packages/platform-worker/wrangler.jsonc',
] as const

test('origin and platform bind MCP search telemetry in production and preview', async () => {
	for (const configPath of searchWorkerConfigPaths) {
		const config = parseJsonc<{
			env?: Record<
				string,
				{
					analytics_engine_datasets?: Array<{
						binding?: string
						dataset?: string
					}>
				}
			>
		}>(await readFile(configPath, 'utf8'))
		for (const envName of ['production', 'preview'] as const) {
			const binding = config.env?.[envName]?.analytics_engine_datasets?.find(
				(entry) => entry.binding === 'MCP_SEARCH_EVENTS',
			)
			const expectedDataset =
				envName === 'production'
					? 'kody_mcp_search_events'
					: 'kody_mcp_search_events_preview'
			expect(binding, `${configPath} env.${envName}`).toEqual({
				binding: 'MCP_SEARCH_EVENTS',
				dataset: expectedDataset,
			})
		}
	}
})

const funnelWorkerConfigPaths = [
	'packages/worker/wrangler.jsonc',
	'packages/platform-worker/wrangler.jsonc',
	'packages/runtime-worker/wrangler.jsonc',
] as const

test('origin, platform, and runtime bind the onboarding funnel in production and preview', async () => {
	for (const configPath of funnelWorkerConfigPaths) {
		const config = parseJsonc<{
			env?: Record<
				string,
				{
					analytics_engine_datasets?: Array<{
						binding?: string
						dataset?: string
					}>
				}
			>
		}>(await readFile(configPath, 'utf8'))
		for (const envName of ['production', 'preview'] as const) {
			const binding = config.env?.[envName]?.analytics_engine_datasets?.find(
				(entry) => entry.binding === 'ONBOARDING_FUNNEL_EVENTS',
			)
			const expectedDataset =
				envName === 'production'
					? 'kody_onboarding_funnel_events'
					: 'kody_onboarding_funnel_events_preview'
			expect(binding, `${configPath} env.${envName}`).toEqual({
				binding: 'ONBOARDING_FUNNEL_EVENTS',
				dataset: expectedDataset,
			})
		}
	}
})

test('resolveEmailSendingEventSubscriptionDomains keeps one entry when domains match', () => {
	expect(
		resolveEmailSendingEventSubscriptionDomains({
			userDomain: 'kody.codes',
			systemDomain: 'kody.codes',
		}),
	).toEqual([{ domain: 'kody.codes', kind: 'user' }])
})

test('resolveEmailSendingEventSubscriptionDomains subscribes both inbox and system domains', () => {
	expect(
		resolveEmailSendingEventSubscriptionDomains({
			userDomain: 'inbox.kody.codes',
			systemDomain: 'kody.codes',
		}),
	).toEqual([
		{ domain: 'inbox.kody.codes', kind: 'user' },
		{ domain: 'kody.codes', kind: 'system' },
	])
})

test('resolveEmailSendingEventSubscriptionDomains normalizes case and trailing dots', () => {
	expect(
		resolveEmailSendingEventSubscriptionDomains({
			userDomain: 'Inbox.Kody.Codes.',
			systemDomain: 'KODY.CODES',
		}),
	).toEqual([
		{ domain: 'inbox.kody.codes', kind: 'user' },
		{ domain: 'kody.codes', kind: 'system' },
	])
})
