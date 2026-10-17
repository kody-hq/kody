# Follows

A workspace follows a package or plain repo to receive `follow.published` (new
versions) and `follow.pushed` (default-branch pushes) events. Each follow is its
own record with its own event choice. The org is always the one in the URL.

## How to get there

- Package or repo page `/@<owner>/<kodyId>` → **Follow** in the repository
  action group opens the Follow panel on the Repo tab. Other tabs link to
  `/@<owner>/<kodyId>#follow`, which opens it on load. Signed-out visitors get a
  sign-in link back to the Repo tab.
- `/@<slug>/-/follows` (workspace rail → Build → Follows) lists the workspace's
  follows with status, pause reason, deletion date for paused rows, Resume, and
  Unfollow. Follow ids live in each row's collapsed **Details**.

## Drive it

Sign in, open the package or repository, and use the Follow panel. Select the
workspace and events, submit, then check the workspace Follows page. Exercise
Resume and Unfollow on the actual page so the test covers native navigation,
server-function authorization, and Query reconciliation.

## Website operations

The website uses typed Start server functions in `start/server/follows.ts`:

- `loadPackageFollow` reads target permissions and available workspaces.
- `loadOrgFollows` reads the selected workspace's follows with `org:read`.
- `followTarget` creates a follow or updates its event choice.
- `resumeFollow` resumes by id under the target's current name.
- `unfollowTarget` removes by id or target, scoped to the selected workspace.

These are website operations, not stable external HTTP APIs. External clients
use the official follow capabilities. There are no website `.json` action
endpoints. Writes authenticate the viewer, bind the explicit workspace, enforce
permissions and rate limits, then reconcile the captured actor's Query data.

## Gotchas

- Pushes need `package:read` on the package (org-wide for plain repos), even for
  public targets. A Use grant qualifies; run-only access does not. The panel
  disables the Pushes checkbox and says why. Plain repos only send pushes, so a
  repo without read access cannot be followed from the web.
- New follows are limited to 30 per workspace per hour. Changing events,
  resuming, and unfollowing do not use a slot.
- Seed users own no packages. Insert a public `user_repos` row for the seed user
  (see `e2e/follows.spec.ts`) to exercise the owner flow.
- Paused follows are deleted 30 days after `paused_at`. Pause reasons are
  `target_missing` and `access_lost`.
