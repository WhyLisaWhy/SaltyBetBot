#!/usr/bin/env bash
set -euo pipefail

backup_repo="${SALTYBET_BACKUP_REPO:-$HOME/.local/share/saltybet-records-publisher}"
backup_branch="${SALTYBET_BACKUP_BRANCH:-automation/personal-records-backup}"
export_file="${SALTYBET_RECORDS_EXPORT:-$HOME/Downloads/SaltyBetBot Backups/personal-records-latest.json}"
snapshot_dir="${SALTYBET_LOCAL_SNAPSHOTS:-$HOME/.local/share/saltybet-records-snapshots}"
target_file="$backup_repo/community-records/personal-records-latest.json"
metadata_file="$backup_repo/community-records/personal-records-metadata.json"

if [[ ! -s "$export_file" ]]; then
  echo "No non-empty Chrome personal-record export is available at $export_file"
  exit 0
fi
if [[ ! -d "$backup_repo/.git" ]]; then
  echo "Backup checkout is missing at $backup_repo" >&2
  exit 1
fi

cd "$backup_repo"
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Backup checkout has uncommitted tracked changes; refusing to overwrite them" >&2
  exit 1
fi

git fetch origin master "$backup_branch" 2>/dev/null || git fetch origin master
if git show-ref --verify --quiet "refs/remotes/origin/$backup_branch"; then
  if git show-ref --verify --quiet "refs/heads/$backup_branch"; then
    git switch "$backup_branch"
  else
    git switch --track -c "$backup_branch" "origin/$backup_branch"
  fi
  git pull --ff-only origin "$backup_branch"
else
  git switch -c "$backup_branch" origin/master
fi

# A merge commit preserves each backup commit as an ancestor of master. Once the
# prior publication is merged, fast-forward the long-lived automation branch.
if git merge-base --is-ancestor "origin/$backup_branch" origin/master 2>/dev/null; then
  git merge --ff-only origin/master
fi

summary=$(node scripts/prepare-personal-records-backup.mjs \
  "$export_file" \
  "$target_file" \
  "$metadata_file")
IFS=$'\t' read -r status record_count first_date last_date sha256 <<<"$summary"

if [[ "$status" == "unchanged" ]]; then
  echo "Personal-record backup is already current ($record_count records, SHA-256 $sha256)"
  exit 0
fi

mkdir -p "$snapshot_dir"
snapshot="$snapshot_dir/personal-records-$(date -u +%Y-%m-%dT%H-%M-%SZ).json"
cp "$export_file" "$snapshot"
find "$snapshot_dir" -type f -name 'personal-records-*.json' -mtime +14 -delete

git add -- \
  community-records/personal-records-latest.json \
  community-records/personal-records-metadata.json
if git diff --cached --quiet; then
  echo "Validated export produced no repository changes"
  exit 0
fi

last_date_iso=$(node -e 'console.log(new Date(Number(process.argv[1])).toISOString())' "$last_date")
git commit -m "Update personal match records ($record_count matches)"

for attempt in 1 2 3; do
  if git push origin "HEAD:$backup_branch"; then
    echo "Published $record_count personal records through $last_date_iso to $backup_branch"
    echo "GitHub will merge the backup into master after the verify check passes"
    exit 0
  fi
  if [[ "$attempt" -eq 3 ]]; then
    break
  fi
  echo "Remote backup branch changed during publication; rebasing and retrying ($attempt/3)"
  git pull --rebase origin "$backup_branch"
done

echo "Unable to publish the personal-record backup after three attempts" >&2
exit 1
