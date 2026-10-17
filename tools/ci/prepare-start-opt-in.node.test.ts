import { expect, test } from 'vitest'
import {
	approvedPeople,
	mapLiveProductionSettings,
} from './prepare-start-opt-in.ts'

const base = {
	main: './src/production-worker.ts',
	env: {
		production: {
			d1_databases: [{ binding: 'OLD', database_id: 'old' }],
			vars: { COOKIE_SECRET: 'old' },
		},
	},
}
test('uses live binding identities and does not carry old or secret values into snapshot', () => {
	const result = mapLiveProductionSettings(base, {
		bindings: [
			{ type: 'plain_text', name: 'APP_BASE_URL', text: 'https://kody.codes' },
			{ type: 'secret_text', name: 'COOKIE_SECRET' },
			{ type: 'd1', name: 'APP_DB', id: 'existing-id' },
			{
				type: 'service',
				name: 'JOBS',
				service: 'kody-jobs',
				entrypoint: 'JobsService',
			},
			{ type: 'queue', name: 'QUEUE', queue_name: 'existing-queue' },
			{
				type: 'durable_object_namespace',
				name: 'DO',
				class_name: 'Shared',
				script_name: 'kody-platform',
			},
			{
				type: 'workflow',
				name: 'FLOW',
				workflow_name: 'existing-flow',
				class_name: 'Flow',
				script_name: 'kody-runtime',
			},
		],
	})
	expect(result.vars).toEqual({ APP_BASE_URL: 'https://kody.codes' })
	expect(result.d1_databases).toEqual([
		{ binding: 'APP_DB', database_id: 'existing-id' },
	])
	expect(result.services).toEqual([
		{
			binding: 'JOBS',
			service: 'kody-jobs',
			entrypoint: 'JobsService',
			environment: undefined,
		},
	])
	expect(result.queues).toEqual({
		producers: [
			{ binding: 'QUEUE', queue: 'existing-queue', delivery_delay: undefined },
		],
	})
	expect(result.durable_objects).toEqual({
		bindings: [
			{
				name: 'DO',
				class_name: 'Shared',
				script_name: 'kody-platform',
				environment: undefined,
			},
		],
	})
	expect(result.workflows).toEqual([
		{
			binding: 'FLOW',
			name: 'existing-flow',
			class_name: 'Flow',
			script_name: 'kody-runtime',
		},
	])
	expect(result.env).toBeUndefined()
	expect(base.env.production.vars.COOKIE_SECRET).toBe('old')
})
test('fails closed for unsupported live bindings', () => {
	expect(() =>
		mapLiveProductionSettings(base, {
			bindings: [{ name: 'NEW', type: 'new-platform-binding' }],
		}),
	).toThrow('Unsupported live binding')
})
test('resolves only the two exact approved account rows', () => {
	expect(
		approvedPeople([
			{ username: 'kentcdodds', stable_user_id: 'b'.repeat(64) },
			{ username: 'tannerlinsley', stable_user_id: 'a'.repeat(64) },
		]),
	).toEqual(['a'.repeat(64), 'b'.repeat(64)])
	expect(() =>
		approvedPeople([
			{ username: 'tannerlinsley', stable_user_id: 'a'.repeat(64) },
		]),
	).toThrow('Both exact')
	expect(() =>
		approvedPeople([
			{ username: 'tannerlinsley', stable_user_id: 'a'.repeat(64) },
			{ username: 'kentcdodds', stable_user_id: 'a'.repeat(64) },
		]),
	).toThrow('distinct')
})
