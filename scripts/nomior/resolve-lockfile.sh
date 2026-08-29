#!/bin/sh
# Resolve a pnpm-lock.yaml merge conflict during an upstream sync merge.
#
# Policy (docs/nomior/FORK-MANIFEST.md): the lockfile is marked merge=binary,
# so any sync merge where both sides touched it stops as a conflict. Never
# hand-merge it — take upstream's lockfile and regenerate our workspace's
# additions on top with `pnpm install --lockfile-only`.
set -eu

repo_root=$(git rev-parse --show-toplevel)
cd "$repo_root"

if ! git rev-parse -q --verify MERGE_HEAD >/dev/null; then
  echo "error: no merge in progress (MERGE_HEAD missing); run this during a sync merge conflict." >&2
  exit 1
fi

if ! git diff --name-only --diff-filter=U | grep -qx "pnpm-lock.yaml"; then
  echo "error: pnpm-lock.yaml is not conflicted in this merge." >&2
  exit 1
fi

echo "Taking upstream's pnpm-lock.yaml (theirs) ..."
git checkout --theirs -- pnpm-lock.yaml

echo "Regenerating the lockfile for our workspace ..."
pnpm install --lockfile-only

git add pnpm-lock.yaml
echo "pnpm-lock.yaml resolved and staged. Resolve any remaining conflicts, then commit the merge."
