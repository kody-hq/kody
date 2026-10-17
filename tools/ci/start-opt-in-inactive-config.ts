type Config = Record<string, unknown>

/** Remove only inert defaults emitted by Wrangler's normalized build config. */
export function normalizeInactiveBuildConfig(
	input: Config,
	expectedName: string,
) {
	const config = structuredClone(input)
	for (const key of [
		'routes',
		'custom_domains',
		'migrations',
		'email',
		'dispatch_namespaces',
		'tail_consumers',
		'streaming_tail_consumers',
	]) {
		if (Array.isArray(config[key]) && config[key].length === 0)
			delete config[key]
	}
	for (const key of ['env', 'unsafe']) {
		const value = config[key]
		if (
			value &&
			typeof value === 'object' &&
			!Array.isArray(value) &&
			Object.keys(value).length === 0
		)
			delete config[key]
	}
	const triggers = config.triggers
	if (triggers && typeof triggers === 'object' && !Array.isArray(triggers)) {
		const entries = Object.entries(triggers)
		if (
			entries.every(
				([key, value]) =>
					key === 'crons' && Array.isArray(value) && value.length === 0,
			)
		)
			delete config.triggers
	}
	const queues = config.queues as Config | undefined
	if (
		queues &&
		Array.isArray(queues.consumers) &&
		queues.consumers.length === 0
	)
		delete queues.consumers
	// The Vite plugin adds migration paths to every D1 binding, even when absent
	// in the source config. The candidate never runs database migrations.
	if (Array.isArray(config.d1_databases)) {
		for (const binding of config.d1_databases as Array<Config>) {
			for (const key of [
				'migrations_dir',
				'migrations_table',
				'migrations_pattern',
			])
				delete binding[key]
		}
	}
	assertInactiveConfig(config, expectedName)
	return config
}

export function assertInactiveConfig(config: Config, expectedName: string) {
	const invalid: Array<string> = []
	if (config.name !== expectedName) invalid.push('name')
	if (config.workers_dev !== false) invalid.push('workers_dev')
	if (config.preview_urls !== false) invalid.push('preview_urls')
	for (const key of [
		'env',
		'routes',
		'route',
		'custom_domains',
		'triggers',
		'migrations',
		'email',
		'unsafe',
		'dispatch_namespaces',
		'tail_consumers',
		'streaming_tail_consumers',
	]) {
		if (config[key] !== undefined) invalid.push(key)
	}
	const queues = config.queues as Config | undefined
	if (queues?.consumers !== undefined) invalid.push('queues.consumers')
	const durable = config.durable_objects as
		| { bindings?: Array<Config> }
		| undefined
	for (const binding of durable?.bindings ?? [])
		if (
			typeof binding.script_name !== 'string' ||
			!binding.script_name ||
			binding.script_name === expectedName
		)
			invalid.push('durable_objects.bindings.script_name')
	for (const workflow of (config.workflows ?? []) as Array<Config>)
		if (
			typeof workflow.script_name !== 'string' ||
			!workflow.script_name ||
			workflow.script_name === expectedName
		)
			invalid.push('workflows.script_name')
	// Field names are useful diagnostics, never print configuration or secret values.
	if (invalid.length)
		throw new Error(
			`Inactive worker config rejected fields: ${[...new Set(invalid)].join(', ')}`,
		)
}
