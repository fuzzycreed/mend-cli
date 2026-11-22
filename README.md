# mend-cli

An edit-applier CLI for the make.fun "mend" bounty (hidden-spec-cli-01).

`main.ts` (Node 22, standard library only) applies model-written edits to a
workspace in four formats — unified diffs, SEARCH/REPLACE blocks, V4A patches
and JSON text-editor tool calls — following the kit's SPEC: fuzzy matching
tiers above strict exact matching, and atomic all-or-nothing changes per file.
`runner.ts` is the kit starter's runner, unmodified.

Verified: 100/100 on the kit's practice checks, plus 174 hand-written extra
checks for spec corners the practice set does not cover.
