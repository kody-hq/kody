import { spawnSync } from 'node:child_process'
import {
	ensureWorkerEnvFile,
	workerEnvExampleRelativePath,
	workerEnvRelativePath,
} from './ensure-dev.ts'
import {
	localPersistEnv,
	resolveLocalD1PersistPath,
} from './local-d1-persist.ts'
import { isExecutedDirectly } from './node-runtime.ts'
import { jobsWorkerWranglerConfigPath } from './wrangler-env-config.ts'

const workerEnvFileArgument = `--env-file=${workerEnvRelativePath}`

function localPersistenceArguments(arguments_: ReadonlyArray<string>) {
	const allowed: Array<string> = []
	for (let index = 0; index < arguments_.length; index += 1) {
		const argument = arguments_[index]!
		if (argument.startsWith('--persist-to=')) {
			allowed.push(argument)
			continue
		}
		if (argument === '--persist-to' && arguments_[index + 1]) {
			allowed.push(argument, arguments_[index + 1]!)
			index += 1
			continue
		}
		throw new Error(
			`Unsupported local migration argument: ${argument}. Only --persist-to is allowed.`,
		)
	}
	return allowed
}

export function resolveLocalMigrationPersistArguments(
	argv: ReadonlyArray<string>,
	env: NodeJS.ProcessEnv = process.env,
) {
	const passthrough = localPersistenceArguments(argv)
	const hasPersist = passthrough.some(
		(argument) =>
			argument === '--persist-to' || argument.startsWith('--persist-to='),
	)
	if (hasPersist) return passthrough
	return ['--persist-to', resolveLocalD1PersistPath({ env })]
}

/**
 * Wrangler config `migrations_dir` for each local binding, resolved from the
 * repo root. The stale-name check compares `d1_migrations` against these.
 */
const localMigrationTargets = [
	{
		binding: 'APP_DB',
		migrationsDir: 'packages/worker/migrations',
		configArguments: [],
	},
	{
		binding: 'AUDIT_DB',
		migrationsDir: 'packages/worker/audit-migrations',
		configArguments: [],
	},
	{
		binding: 'JOBS_DB',
		migrationsDir: 'packages/jobs-worker/migrations',
		configArguments: ['--config', jobsWorkerWranglerConfigPath],
	},
] as const

function staleCheckCommand(
	target: (typeof localMigrationTargets)[number],
	persistArguments: ReadonlyArray<string>,
) {
	return [
		'tools/check-stale-local-migrations.ts',
		'--binding',
		target.binding,
		'--migrations-dir',
		target.migrationsDir,
		...target.configArguments,
		...persistArguments,
	]
}

function applyCommand(
	target: (typeof localMigrationTargets)[number],
	persistArguments: ReadonlyArray<string>,
) {
	return [
		workerEnvFileArgument,
		'./wrangler-env.ts',
		'd1',
		'migrations',
		'apply',
		target.binding,
		'--local',
		...target.configArguments,
		...persistArguments,
	]
}

/**
 * APP_DB, AUDIT_DB, and JOBS_DB migrations for one local persist directory.
 * Bookkeeping reset stays APP_DB-only; it rewrites pre-squash `d1_migrations`
 * rows before the stale-name checks. All three stale checks run before any
 * apply so a disposable e2e reset cannot wipe a binding that already applied.
 * Durable local state still fails when it records a migration name that is
 * no longer on disk. `0090-teams-credential-org-binding.sql` rewrites API
 * token scopes in SQL. The same map lives in
 * `packages/worker/src/api-tokens/legacy-scope-rewrite.ts`.
 */
export function buildLocalMigrationCommands(input: {
	argv: ReadonlyArray<string>
	env?: NodeJS.ProcessEnv
}) {
	const persistArguments = resolveLocalMigrationPersistArguments(
		input.argv,
		input.env,
	)
	return [
		['tools/ci/reset-migration-bookkeeping.ts', '--local', ...persistArguments],
		...localMigrationTargets.map((target) =>
			staleCheckCommand(target, persistArguments),
		),
		...localMigrationTargets.map((target) =>
			applyCommand(target, persistArguments),
		),
	]
}

function runNode(arguments_: ReadonlyArray<string>) {
	return spawnSync(process.execPath, arguments_, {
		cwd: process.cwd(),
		encoding: 'utf8',
		env: process.env,
		maxBuffer: 16 * 1024 * 1024,
	})
}

function main() {
	// `npm run dev` loads this file with `--env-file`. Create it here so a
	// fresh `migrate:local` has the file before Wrangler starts.
	const envFile = ensureWorkerEnvFile()
	if (envFile.created) {
		console.log(
			`Created ${workerEnvRelativePath} from ${workerEnvExampleRelativePath}`,
		)
	}
	for (const command of buildLocalMigrationCommands({
		argv: process.argv.slice(2),
		env: localPersistEnv(process.env, envFile.path),
	})) {
		const result = runNode(command)
		process.stdout.write(result.stdout ?? '')
		process.stderr.write(result.stderr ?? '')
		if (result.status !== 0) {
			process.exit(result.status ?? 1)
		}
	}
}

if (isExecutedDirectly(import.meta.url)) {
	main()
}
