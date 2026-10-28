/**
 * Re-export prefer-local guidance from universal so MCP instruction modules
 * keep a stable import path. Source of truth:
 * {@link preferLocalCliExecuteGuidance} in `#universal/prefer-local-cli-execute.ts`.
 */
export {
	preferLocalCliExecuteCommand,
	preferLocalCliExecuteGuidance,
	preferLocalExecuteLimitGuidance,
	preferLocalExecuteNudgeWarning,
} from '#universal/prefer-local-cli-execute.ts'
