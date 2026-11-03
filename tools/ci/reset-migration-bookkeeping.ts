/**
 * One-shot deterministic guard for the 2026-08-04 migration-history squash.
 *
 * The squash replaced the full ledgered migration history (0001-init.sql
 * through 0144-drop-jobs-observability-columns.sql) with the single
 * 0001-squashed-init.sql baseline. The schema is unchanged; only the
 * `d1_migrations` bookkeeping table must be rewritten so Wrangler treats the
 * squashed baseline as already applied.
 *
 * Runs BEFORE `wrangler d1 migrations apply APP_DB` for local applies via
 * tools/apply-local-app-migrations, so developer state dirs created before
 * the squash still get their bookkeeping rewritten. The production and
 * preview databases settled post-squash on 2026-08-05 and their deploy
 * workflow invocations have been removed. Exactly three database states are
 * accepted:
 *
 * 1. fresh — no `d1_migrations` table or zero rows: nothing to do; the
 *    regular apply bootstraps the squashed baseline.
 * 2. squashed — bookkeeping holds the squashed baseline row plus only
 *    post-squash migrations (0002+ applied by the ordinary apply step after
 *    the squash): nothing to do.
 * 3. pre-squash — bookkeeping holds exactly the full frozen pre-squash
 *    migration name set: reset to the single squashed baseline row.
 *
 * Anything else fails loudly with a set diff and the apply never runs. This
 * is the deterministic "do we still have exactly the migrations we should"
 * check that gates the destructive bookkeeping rewrite.
 *
 * Once pre-squash local developer state dirs have died out, the local
 * invocation and this script can be deleted entirely.
 */

import { isExecutedDirectly } from '../node-runtime.ts'
import { executeWranglerD1, runWranglerD1 } from '../wrangler-d1-execute.ts'

export const squashedInitMigrationName = '0001-squashed-init.sql'

/**
 * Frozen: the exact migration names recorded in the migration ledger
 * at the final pre-squash main commit (63616db6). Immutable by definition —
 * these migrations were applied to production and can never change.
 */
export const preSquashMigrationNames: ReadonlyArray<string> = [
	'0001-init.sql',
	'0002-chat-threads.sql',
	'0003-mock-ai-requests.sql',
	'0004-mcp-skills.sql',
	'0005-skill-parameters.sql',
	'0006-ui-artifacts.sql',
	'0007-drop-mock-request-tables.sql',
	'0008-secret-buckets.sql',
	'0009-secret-allowed-hosts.sql',
	'0009-ui-artifact-parameters.sql',
	'0010-secret-allowed-capabilities.sql',
	'0010-value-buckets.sql',
	'0011-remove-ui-artifacts-search-columns.sql',
	'0012-skill-collections.sql',
	'0013-ui-artifact-search-visibility.sql',
	'0014-skill-names.sql',
	'0015-mcp-user-server-instructions.sql',
	'0016-mcp-memories.sql',
	'0017-saved-app-facets.sql',
	'0018-jobs.sql',
	'0018-mcp-memory-source-uris.sql',
	'0019-jobs-constraints.sql',
	'0020-jobs-codemode-only.sql',
	'0021-jobs-storage-id.sql',
	'0022-secret-entry-lookup-hash.sql',
	'0023-entity-sources.sql',
	'0023-secret-allowed-packages.sql',
	'0024-repo-sessions-and-source-columns.sql',
	'0025-jobs-repo-check-policy.sql',
	'0026-drop-legacy-inline-sources.sql',
	'0027-saved-packages.sql',
	'0028-published-bundle-artifacts-and-archived-jobs.sql',
	'0029-package-invocations.sql',
	'0030-email-primitives.sql',
	'0031-unified-email-receipt.sql',
	'0032-entity-sources-external-check.sql',
	'0033-drop-legacy-inline-sources-archive.sql',
	'0034-remote-connector-settings.sql',
	'0035-workflow-runs.sql',
	'0036-workflow-runs-idempotency-index.sql',
	'0037-drop-chat-threads.sql',
	'0037-package-runtime-debug.sql',
	'0038-backfill-usernames.sql',
	'0040-drop-source-rescue-events.sql',
	'0041-repo-session-branches.sql',
	'0042-drop-legacy-skill-app-tables.sql',
	'0043-rbac.sql',
	'0044-rbac-backfill-user-role.sql',
	'0045-community-listings.sql',
	'0046-invites-email-verification.sql',
	'0047-usage-rollups.sql',
	'0048-user-plans-and-entitlement-counters.sql',
	'0049-audit-events.sql',
	'0050-drop-remote-connector-kind.sql',
	'0051-system-email-daily-counters.sql',
	'0052-stable-user-id-email-changes.sql',
	'0053-mcp-server-settings.sql',
	'0053-two-factor-passkeys.sql',
	'0054-email-blob-storage.sql',
	'0055-retention-indexes.sql',
	'0056-oauth-connections.sql',
	'0057-package-scoped-secrets.sql',
	'0058-saved-packages-hidden.sql',
	'0059-community-trusted-listings.sql',
	'0060-community-featured-listings.sql',
	'0061-email-delivery-lifecycle.sql',
	'0062-platform-feedback.sql',
	'0063-platform-feedback-submitter-snapshot.sql',
	'0064-feature-flags.sql',
	'0065-invite-plans.sql',
	'0066-stripe-billing.sql',
	'0067-personal-plan-to-pro.sql',
	'0068-community-social.sql',
	'0069-user-avatars.sql',
	'0070-community-fork-listing-snapshots.sql',
	'0071-passkey-labels.sql',
	'0072-package-scope-grants.sql',
	'0073-agent-package-conversation-uses.sql',
	'0073-community-forks-forked-package-index.sql',
	'0074-community-fork-adoption.sql',
	'0075-stable-user-id-not-null.sql',
	'0076-email-raw-mime-offload-blocked.sql',
	'0077-drop-email-raw-mime-inline.sql',
	'0078-email-sender-identities-verified-only.sql',
	'0079-drop-email-inbox-address-reply-token-hash.sql',
	'0080-backfill-unlimited-plan.sql',
	'0081-plan-not-null.sql',
	'0082-rename-unlimited-plan-to-max.sql',
	'0083-plan-default-free.sql',
	'0084-account-deleting-state.sql',
	'0085-account-write-leases.sql',
	'0086-mcp-agent-sessions.sql',
	'0087-account-write-lease-tokens.sql',
	'0088-mcp-agent-session-backfill-marker.sql',
	'0089-email-delivery-reconciliation-index.sql',
	'0090-webhook-endpoints.sql',
	'0091-user-abuse-controls.sql',
	'0092-password-changed-at.sql',
	'0093-stripe-webhook-events.sql',
	'0094-activation-milestones.sql',
	'0095-package-service-states.sql',
	'0096-user-package-run-successes.sql',
	'0097-user-storage-buckets.sql',
	'0098-backfill-package-service-states.sql',
	'0099-drop-run-history-legacy.sql',
	'0100-job-retention.sql',
	'0101-user-oauth-apps-and-integrations.sql',
	'0102-user-openapi-bindings.sql',
	'0103-integration-data-hygiene.sql',
	'0104-email-sender-rules-and-classification.sql',
	'0105-restore-safe-row-sizes.sql',
	'0107-job-execution-claims.sql',
	'0108-user-storage-buckets-package-kind.sql',
	'0109-delete-stranded-app-value-buckets.sql',
	'0110-enable-execute-pre-exec-typecheck-for-kentcdodds.sql',
	'0111-package-codemod-ledger.sql',
	'0112-drop-package-invocations.sql',
	'0113-plan-check-constraints.sql',
	'0114-platform-feedback-submitter-snapshots-not-null.sql',
	'0115-delete-integration-secret-values.sql',
	'0116-job-expires-at.sql',
	'0117-feature-flag-exposure-rollups.sql',
	'0118-user-storage-bucket-estimated-bytes.sql',
	'0121-drop-legacy-storage-and-backfill-marker.sql',
	'0122-user-d1-storage-bytes.sql',
	'0123-inbound-delivery-effect-indexes.sql',
	'0124-entity-sources-external-reconcile-pending.sql',
	'0125-mailbox-parity-state.sql',
	'0126-drop-entitlement-daily-counters.sql',
	'0127-drop-legacy-audit-events.sql',
	'0128-email-outbound-provider-index.sql',
	'0129-email-inbound-mailbox-authority-mirror.sql',
	'0130-system-email-graph-expand.sql',
	'0131-system-email-graph-authority.sql',
	'0132-email-outbound-provider-index-detach.sql',
	'0133-email-user-graph-authority.sql',
	'0134-email-user-graph-drop-approval.sql',
	'0135-drop-legacy-email-graph.sql',
	'0136-user-repos.sql',
	'0137-drop-legacy-runlog-d1-projections.sql',
	'0138-entity-sources-artifacts-push-subscription.sql',
	'0139-drop-storage-bytes-mirror-columns.sql',
	'0141-drop-account-write-leases-and-stale-flags.sql',
	'0143-drop-email-postdrop-residue.sql',
	'0144-drop-jobs-observability-columns.sql',
]

/**
 * Pre-ledger bookkeeping ghosts: rows that exist in long-lived databases
 * (production) because a migration file was applied and then renamed or
 * deleted before the migration ledger froze history. Wrangler keys applied
 * migrations by filename, so the old name's row survives. Provenance:
 *
 * - `0006-drop-mock-request-tables.sql` — applied, then renamed to
 *   `0007-drop-mock-request-tables.sql` when `0006-ui-artifacts.sql` took
 *   the prefix (PR #29); production holds rows for both names.
 * - `0039-source-rescue-events.sql` — applied, then deleted by the source
 *   rescue revert (PR #531); `0040-drop-source-rescue-events.sql` removed
 *   its tables and the 0039 row remained.
 *
 * Databases may hold any subset of these in addition to the frozen set.
 */
export const preSquashGhostMigrationNames: ReadonlyArray<string> = [
	'0006-drop-mock-request-tables.sql',
	'0039-source-rescue-events.sql',
]

export type BookkeepingClassification =
	| { state: 'fresh' }
	| { state: 'squashed' }
	| { state: 'pre-squash' }
	| { state: 'unexpected'; missing: Array<string>; extra: Array<string> }

export function classifyMigrationBookkeeping(
	appliedNames: ReadonlyArray<string>,
): BookkeepingClassification {
	if (appliedNames.length === 0) {
		return { state: 'fresh' }
	}
	// Post-squash steady state: the squashed baseline plus only migrations
	// that are not part of the frozen pre-squash history (ordinary 0002+
	// migrations applied after the squash). Any mixture of the baseline with
	// frozen pre-squash names still fails below.
	if (appliedNames.includes(squashedInitMigrationName)) {
		const preSquash = new Set([
			...preSquashMigrationNames,
			...preSquashGhostMigrationNames,
		])
		const onlyPostSquashExtras = appliedNames.every(
			(name) => name === squashedInitMigrationName || !preSquash.has(name),
		)
		if (onlyPostSquashExtras) {
			return { state: 'squashed' }
		}
	}
	const applied = new Set(appliedNames)
	const expected = new Set(preSquashMigrationNames)
	const ghosts = new Set(preSquashGhostMigrationNames)
	const missing = [...expected].filter((name) => !applied.has(name)).sort()
	const extra = [...applied]
		.filter((name) => !expected.has(name) && !ghosts.has(name))
		.sort()
	if (missing.length === 0 && extra.length === 0) {
		return { state: 'pre-squash' }
	}
	return { state: 'unexpected', missing, extra }
}

type CliOptions = {
	mode: '--remote' | '--local'
	config?: string
	persistTo?: string
	binding: string
}

export function parseArgs(argv: ReadonlyArray<string>): CliOptions {
	const options: CliOptions = { mode: '--local', binding: 'APP_DB' }
	let sawMode = false
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index]
		if (!argument) continue
		if (argument.startsWith('--persist-to=')) {
			options.persistTo = argument.slice('--persist-to='.length)
			continue
		}
		switch (argument) {
			case '--remote':
			case '--local': {
				options.mode = argument
				sawMode = true
				break
			}
			case '--config': {
				const value = argv[index + 1]
				if (!value) throw new Error('--config requires a path')
				options.config = value
				index += 1
				break
			}
			case '--persist-to': {
				const value = argv[index + 1]
				if (!value) throw new Error('--persist-to requires a path')
				options.persistTo = value
				index += 1
				break
			}
			case '--binding': {
				const value = argv[index + 1]
				if (!value) throw new Error('--binding requires a name')
				options.binding = value
				index += 1
				break
			}
			default: {
				throw new Error(
					`Unsupported argument: ${argument}. Supported: --remote | --local, --config <path>, --persist-to <path>, --binding <name>.`,
				)
			}
		}
	}
	if (!sawMode) {
		throw new Error(
			'Pass --remote (CI against Cloudflare) or --local (Miniflare state) explicitly.',
		)
	}
	return options
}

function d1Target(options: CliOptions) {
	return {
		mode: options.mode,
		...(options.config ? { config: options.config } : {}),
		...(options.persistTo ? { persistTo: options.persistTo } : {}),
	}
}

function queryRows(options: CliOptions, sql: string) {
	return executeWranglerD1({
		...d1Target(options),
		binding: options.binding,
		sql,
	})
}

function queryAppliedMigrationNames(options: CliOptions): Array<string> | null {
	// Probing sqlite_master succeeds on any database (including one that the
	// probe itself just materialized), unlike selecting from a table that may
	// not exist yet.
	const tables = queryRows(
		options,
		"SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'd1_migrations';",
	)
	if (tables.length === 0) {
		return null
	}
	const rows = queryRows(
		options,
		'SELECT name FROM d1_migrations ORDER BY name;',
	)
	return rows.map((row) => String(row.name))
}

function resetBookkeeping(options: CliOptions): void {
	try {
		executeWranglerD1({
			...d1Target(options),
			binding: options.binding,
			sql: `DELETE FROM d1_migrations; INSERT INTO d1_migrations (name) VALUES ('${squashedInitMigrationName}');`,
		})
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		throw new Error(`Bookkeeping reset failed: ${message}`)
	}
}

function printTimeTravelAnchor(options: CliOptions): void {
	if (options.mode !== '--remote') return
	const result = runWranglerD1(d1Target(options), [
		'time-travel',
		'info',
		options.binding,
	])
	if (result.status === 0) {
		console.log('D1 Time Travel rollback anchor before bookkeeping reset:')
		console.log(result.stdout.trim())
	} else {
		console.warn('Could not read D1 Time Travel info (continuing).')
	}
}

export function main(argv: ReadonlyArray<string>): void {
	const options = parseArgs(argv)
	const appliedNames = queryAppliedMigrationNames(options)
	const classification = classifyMigrationBookkeeping(appliedNames ?? [])

	switch (classification.state) {
		case 'fresh': {
			console.log(
				`Migration bookkeeping (${options.binding}): fresh database; regular apply will bootstrap ${squashedInitMigrationName}.`,
			)
			return
		}
		case 'squashed': {
			console.log(
				`Migration bookkeeping (${options.binding}): already squashed; nothing to do.`,
			)
			return
		}
		case 'pre-squash': {
			console.log(
				`Migration bookkeeping (${options.binding}): verified all ${String(preSquashMigrationNames.length)} pre-squash migrations are applied; resetting to ${squashedInitMigrationName}.`,
			)
			printTimeTravelAnchor(options)
			resetBookkeeping(options)
			const verifyNames = queryAppliedMigrationNames(options) ?? []
			const verify = classifyMigrationBookkeeping(verifyNames)
			if (verify.state !== 'squashed') {
				throw new Error(
					`Bookkeeping reset verification failed; d1_migrations now holds: ${verifyNames.join(', ')}`,
				)
			}
			console.log(
				`Migration bookkeeping (${options.binding}): reset complete and verified.`,
			)
			return
		}
		case 'unexpected': {
			const missingList = classification.missing.join(', ') || '(none)'
			const extraList = classification.extra.join(', ') || '(none)'
			throw new Error(
				`Migration bookkeeping (${options.binding}) does not match any expected state; refusing to touch it.\n` +
					`Missing vs frozen pre-squash set: ${missingList}\n` +
					`Extra vs frozen pre-squash set: ${extraList}`,
			)
		}
		default: {
			const exhaustivenessCheck: never = classification
			throw new Error(`Unhandled state: ${String(exhaustivenessCheck)}`)
		}
	}
}

if (isExecutedDirectly(import.meta.url)) {
	main(process.argv.slice(2))
}
