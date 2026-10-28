import { type BackupRuntimeStep } from './backup-runtime.ts'
import { BackupError } from './backup-policy.ts'
import { nonRetryableBackupError } from './workflow-terminal-error.ts'

async function runStepCallback<T>(callback: () => Promise<T>): Promise<T> {
	try {
		return await callback()
	} catch (error) {
		if (error instanceof BackupError && !error.retryable) {
			throw nonRetryableBackupError(error)
		}
		throw error
	}
}

export function withNonRetryableBackupErrors(
	step: BackupRuntimeStep,
): BackupRuntimeStep {
	return {
		do<T>(
			name: string,
			configOrCallback: unknown,
			callback?: () => Promise<T>,
		): Promise<T> {
			if (typeof configOrCallback === 'function') {
				return step.do(name, () =>
					runStepCallback(configOrCallback as () => Promise<T>),
				)
			}
			if (!callback) {
				throw new Error('Workflow step callback is required.')
			}
			return step.do(name, configOrCallback, () => runStepCallback(callback))
		},
		sleep(name, duration) {
			return step.sleep(name, duration)
		},
	}
}
