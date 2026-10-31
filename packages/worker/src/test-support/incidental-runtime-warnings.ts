import { silenceExpectedConsoleWarns } from './console-spies.ts'

// The worker bundler warns that it is experimental, and the registry runtime's
// optional MCP-server, usage, run-record, and activation lookups warn when
// their tables or bindings are absent from the unit-test schema. The first
// kody.* dispatch probe can also warn under workers-unit isolation; this tag
// stays allowlisted so that incidental budget noise does not fail unrelated
// suites. Tests that run those paths swallow exactly these messages; any
// other warning still fails the test so real problems are never silently
// suppressed.
const incidentalRuntimeWarnings = [
	/^\[worker-bundler\] /,
	'mcp-server-refs-load-failed',
	'usage-event-record-failed',
	'usage-event-analytics-failed',
	'usage-rollup-failed',
	'entitlement-storage-bytes-shadow-failed',
	'run-record-begin-failed',
	'run-record-start-failed',
	'run-record-finish-failed',
	'activation-milestone-failed',
	'activation-run-record-failed',
	'artifacts-push-subscription-ensure-failed',
	'kody-first-capability-dispatch-slow',
	// Fire-and-forget estimate refresh after packageStorage / StorageRunner
	// writes. The dedicated storage-buckets suite asserts the message; other
	// workers-unit files that touch storage should not flake when a refresh
	// fails in the isolate.
	'storage-bucket-estimate-refresh-failed',
	// Inbound fixtures often have no Authentication-Results. Classification
	// then runs nothing and logs; the mailbox write under test still finishes.
	'inbound-email-sender-unverified',
	// Package app calls refused as not declared log a hard-rejection line. The
	// authority suites assert it; other app suites hit it incidentally.
	/^\{"event":"package_app_authority_rejection"/,
]

export function silenceIncidentalRuntimeWarnings(
	extraPatterns: Array<RegExp | string> = [],
) {
	silenceExpectedConsoleWarns([...incidentalRuntimeWarnings, ...extraPatterns])
}
