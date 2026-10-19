## Intent

<!-- Overarching goal of this change — what it is for, not how it works. -->

**Door:** `two-way` | `one-way`
<!--
`two-way`: cheap to reverse — ship and change if wrong.
`one-way`: expensive to undo (stored shapes, public contracts, deleted user data) — spend the review here.
-->

**Cleanup:** `none` | `needed` | `done`
<!--
`none`: no leftover old lane.
`needed`: migration left something to delete later — fill What to delete below.
`done`: leftovers already removed in this PR.
-->

**What to delete:** <!-- only when Cleanup is `needed` -->

## Why

<!-- Why this change is needed. -->

## Summary

<!-- What changed. Short bullets are fine. -->

## Referenced issues and PRs

<!--
Use a GitHub closing keyword (Fixes / Closes / Resolves #1234) when this PR
actually fixes an issue so merge auto-closes it. A bare #1234 mention does not
close issues. For related work that this PR does not fully fix, use a
non-closing reference (Related to #1234, or a plain link). Never write
"does not close #N" — GitHub still treats the substring "close #N" as a
closing keyword.
-->

## Testing

<!-- What you ran or verified (validate, focused suites, local control-kody,
     preview only when local cannot exercise the change, production evidence).
     Reviewers: scrutinize test-expectation/assertion changes made in the same
     PR as the code they test; push back when an assertion was rewritten to
     match a behavior change without justification. -->

## System changes

<!-- Optional for non-trivial work: primitives touched and risk. See visual-recap skill. -->
