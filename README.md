# mend-patch-cli

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/lewismarilyn177-spec/mend-patch-cli/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/lewismarilyn177-spec/mend-patch-cli/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend is one command-line patch tool that applies an AI-written edit to a tree of text files, whichever of the four
edit formats the model used: a unified diff (even with drifted line numbers and whitespace), SEARCH/REPLACE blocks,
the V4A patch format, or text-editor tool calls as JSON. It finds the lines an edit names at three matching tiers
(exact, trailing-whitespace-insensitive, and fully whitespace-insensitive with re-indentation), and it writes every
change or none of them: a patch in which any edit fails leaves the tree untouched and prints one `error:` line per
failed edit.

## Run it

```sh
node main.ts [--format=unified|search-replace|v4a|json] [--check] [--strict] [PATCH]
```

Node 22 and its standard library only; nothing is installed. The patch file (or `-` for standard input) is read
relative to the working directory, and every path inside the patch is relative to that directory too. `--check`
reports what would change without touching the tree, and `--strict` disables the forgiving whitespace tiers.

Entered on [make.fun](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards
