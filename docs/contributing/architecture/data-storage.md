# Data storage

Kody uses D1 for relational records, KV and R2 for snapshots and blobs, and
Durable Objects for stateful services. The
[topic index](./data-storage/index.md) links ownership, account cleanup, runtime
bindings, and persistent formats. The section reference below preserves direct
links into the storage overview.

## Section reference

### Per-user isolation invariant

See
[Storage isolation](./data-storage/isolation.md#per-user-isolation-invariant).

### Account deletion inventory

See
[Account storage lifecycle](./data-storage/account-lifecycle.md#account-deletion-inventory).

### Account export inventory

See
[Account storage lifecycle](./data-storage/account-lifecycle.md#account-export-inventory).

### D1 (`APP_DB`)

See [Storage services](./data-storage/services.md#d1-app_db).

### D1 (`JOBS_DB`)

See [Storage services](./data-storage/services.md#d1-jobs_db).

### Analytics Engine reporting

See [Storage services](./data-storage/services.md#analytics-engine-reporting).

### KV (`OAUTH_KV`, `BUNDLE_ARTIFACTS_KV`)

See
[Storage services](./data-storage/services.md#kv-oauth_kv-bundle_artifacts_kv).

### R2 (`COMMUNITY_ASSETS`, `EMAIL_BLOBS`, `FILE_BLOBS`, `REPO_SESSION_BLOBS`)

See
[Storage services](./data-storage/services.md#r2-community_assets-email_blobs-file_blobs-repo_session_blobs).

### Durable Objects (`MCP_OBJECT`)

See [Storage services](./data-storage/services.md#durable-objects-mcp_object).

### Durable Objects (`JobManager` and `StorageRunner`)

See
[Storage services](./data-storage/services.md#durable-objects-jobmanager-and-storagerunner).

### Durable Objects (`UserMeter`)

See [Storage services](./data-storage/services.md#durable-objects-usermeter).

### Durable Objects (`Mailbox`)

See [Storage services](./data-storage/services.md#durable-objects-mailbox).

### Per-user Durable Object naming

See
[Storage runtime and configuration](./data-storage/runtime.md#per-user-durable-object-naming).

### Per-user runtime context (no shared `globalThis`)

See
[Storage runtime and configuration](./data-storage/runtime.md#per-user-runtime-context-no-shared-globalthis).

### Configuration reference

See
[Storage runtime and configuration](./data-storage/runtime.md#configuration-reference).

### Repo-backed source and Artifacts

See
[Repo-backed source and Artifacts](./data-storage/source.md#repo-backed-source-and-artifacts).

### Frozen storage contract inventory

See
[Frozen storage contracts](./data-storage/contracts.md#frozen-storage-contract-inventory).

### Vectorize metadata contracts

See
[Vectorize metadata contracts](./data-storage/contracts.md#vectorize-metadata-contracts).
