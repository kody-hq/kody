/**
 * A write lease lapses this long after its last renewal, so a writer whose
 * isolate was killed stops blocking account and org deletion on its own.
 */
export const writeLeaseTtlMs = 2 * 60 * 1000
/** How often a running writer renews its lease; well inside the TTL. */
export const accountWriteLeaseHeartbeatMs = 30 * 1000
/** A blocking lease older than this is reported to operators as stuck. */
export const staleBlockingAccountWriteLeaseMs = 5 * 60 * 1000
