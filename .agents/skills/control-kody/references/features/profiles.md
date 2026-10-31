# Agent profiles

Behind the `profiles` feature flag (audience `experiments_opt_in`). Not the
public profile (the Public profile account page).

## Seed / reach

```bash
npm run control-kody -- login
npm run control-kody -- request GET /@jane/-/profiles --contains 'Agent profiles'
```

With the flag off the page shows the opt-in callout. Turn it on for the local
user from `/account/experiments` or the callout's Try button, then create a
profile from the page (or `profileCreate`) to see the tree.

## Assert

- `/@{$orgSlug}/-/profiles` (`?members=all` lists every member's profiles for
  team-org Owners); `/account/profiles` redirects to the personal org
- Rail item "Agent profiles" sits in Agents & data right after Agents, with an
  Experiment badge while the flag is off
- Tree uses `role="tree"` / `treeitem`, arrow keys move and expand/collapse, and
  `parent_inactive` rows are dashed and muted
- Expiry only moves earlier; a later time shows `profile_expiry_extension`
- Owners see Revoke but not Edit / Add sub-profile on other members' profiles
- A new profile token's value shows once with a copy button
