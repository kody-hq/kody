import { NonRetryableError } from 'cloudflare:workflows'

import {
	type BackupError,
	workflowBackupErrorMessage,
} from './backup-policy.ts'

/**
 * Fails the current workflow step with no further attempts. The Workflows
 * engine treats a failure as terminal only when `error.name` is
 * `NonRetryableError` (or the message starts with it); errors cross an RPC
 * boundary, so it cannot use `instanceof`. A custom `name` silently makes the
 * step retryable, so this keeps the default name. The backup code stays in the
 * message as `[code] message`, where `errorCode()` and the status pages read it.
 */
export function nonRetryableBackupError(
	error: Pick<BackupError, 'code' | 'message'>,
): NonRetryableError {
	return new NonRetryableError(workflowBackupErrorMessage(error))
}
