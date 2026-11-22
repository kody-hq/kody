#!/usr/bin/env python3
"""Identical SQL fixtures (community listing, package jobs) written into a stopped
variant's local miniflare D1 state. Usage: seed-sql.py <worktree-root>"""
import glob, json, os, sqlite3, sys

root = sys.argv[1]
# Stable owner id of me@kentcdodds.com (user-me), identical on every variant.
OWNER = '51bf22a9d3f5dee8d873123638ff17178727e4db9a407f4eb77982ecddfc059b'
d1 = os.path.join(root, '.wrangler/state/v3/d1/miniflare-D1DatabaseObject')
app = jobs = None
for f in glob.glob(os.path.join(d1, '*.sqlite')):
    if f.endswith('metadata.sqlite'):
        continue
    c = sqlite3.connect(f)
    tables = {r[0] for r in c.execute("select name from sqlite_master where type='table'")}
    if 'saved_packages' in tables:
        app = c
    elif 'jobs' in tables and 'jobs_worker_state' in tables:
        jobs = c
assert app and jobs, 'missing app or jobs D1'

pkgs = app.execute(
    "select id, user_id, kody_id, source_id from saved_packages where kody_id like 'local-seed-pkg-%' and user_id = ? order by kody_id",
    (OWNER,),
).fetchall()
assert len(pkgs) >= 4, f'need >=4 seeded packages, found {len(pkgs)}'
owner = pkgs[0][1]
readme = '# Local seed package 1\n\n' + '\n\n'.join(
    f'## Section {i}\n\nThis package fixture exists so the community detail page renders realistic README content. It lists tools, jobs and credentials used by the benchmark.'
    for i in range(1, 9)
)
pid, _, kid, sid = pkgs[0]
app.execute("update saved_packages set is_private = 0 where id = ?", (pid,))
app.execute(
    """insert or replace into community_listings (id, owner_user_id, package_id, source_id, kody_id, name, description,
    tags_json, category, search_text, readme_content, license, package_version, pinned_commit, status,
    created_at, updated_at, published_at)
    values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
    ('bench-listing-1', owner, pid, sid, kid, kid, 'Benchmark community fixture package',
     '["benchmark","fixture"]', None, f'{kid} benchmark fixture', readme, 'MIT', '1.0.0',
     'b' * 40, 'active', '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z'),
)
app.commit()

caller = json.dumps({'user': {'userId': owner, 'email': 'me@kentcdodds.com', 'displayName': 'user-me'}})
schedules = [{'type': 'cron', 'expression': '0 * * * *'}, {'type': 'interval', 'every': '30m'},
             {'type': 'cron', 'expression': '15 9 * * 1-5'}]
jobs.execute("delete from jobs where name like 'bench-job-%'")
n = 0
for pid, owner_id, kid, sid in pkgs[:4]:
    for j in range(3):
        n += 1
        job_id = f'package-job:{pid}:bench-job-{n}'
        jobs.execute(
            """insert or replace into jobs (id, user_id, name, source_id, published_commit, repo_check_policy_json, storage_id,
            params_json, schedule_json, timezone, enabled, kill_switch_enabled, expires_at, caller_context_json, created_at,
            updated_at, last_run_at, last_run_status, next_run_at, created_by_user_id)
            values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (job_id, owner_id, f'bench-job-{n}', sid, None, None, f'job-storage-bench-{n}',
             json.dumps({'channel': f'#bench-{n}', 'limit': n}), json.dumps(schedules[j]), 'America/Denver',
             1, 0, None, caller, '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z',
             '2026-11-20T00:00:00.000Z', 'success' if n % 4 else 'error', '2027-06-01T00:00:00.000Z', owner_id),
        )
jobs.execute("delete from jobs where id like 'package-job:%:bench-job-%' and user_id <> ?", (OWNER,))
jobs.commit()
print(json.dumps({'owner': owner, 'packages': len(pkgs), 'jobs': n, 'listing': 'bench-listing-1'}))
