import { McpCallerError } from './caller-error.ts'

/**
 * The caller used a request shape this server no longer accepts. The API
 * answers 426 `upgrade_required` with `details.minimum_cli_version`.
 */
export class UpgradeRequiredError extends McpCallerError {
	readonly minimumCliVersion: string

	constructor(input: { message: string; minimumCliVersion: string }) {
		super(input.message)
		this.name = 'UpgradeRequiredError'
		this.minimumCliVersion = input.minimumCliVersion
	}
}
