#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
backup_repo="${SALTYBET_BACKUP_REPO:-$HOME/.local/share/saltybet-records-publisher}"
backup_branch="${SALTYBET_BACKUP_BRANCH:-automation/personal-records-backup}"
export_file="${SALTYBET_RECORDS_EXPORT:-$HOME/Downloads/SaltyBetBot Backups/personal-records-latest.json}"
snapshot_dir="${SALTYBET_LOCAL_SNAPSHOTS:-$HOME/.local/share/saltybet-records-snapshots}"
state_dir="${SALTYBET_BACKUP_STATE_DIR:-$HOME/.local/state/saltybet-records-backup}"
status_file="$state_dir/status.json"
prepare_script="${SALTYBET_PREPARE_SCRIPT:-$script_dir/prepare-personal-records-backup.mjs}"
status_helper="${SALTYBET_STATUS_HELPER:-$script_dir/personal-records-backup-status.mjs}"
target_file="$backup_repo/community-records/personal-records-latest.json"
metadata_file="$backup_repo/community-records/personal-records-metadata.json"

record_success() {
  node "$status_helper" success "$status_file" "$1" "$2" "$3" || true
}

trap 'exit_status=$?; if [[ "$exit_status" -ne 0 ]]; then node "$status_helper" failure "$status_file" "Publisher failed with exit status $exit_status" || true; fi' EXIT

if [[ ! -s "$export_file" ]]; then
  echo "No non-empty Chrome personal-record export is available at $export_file"
  node "$status_helper" failure "$status_file" "No non-empty Chrome personal-record export is available at $export_file" || true
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

# Do not use git pull here. Git 2.53 can append multiple refs to FETCH_HEAD,
# especially while the watchdog fetches master from this same checkout. Named
# remote refs keep the sync deterministic and avoid that shared file entirely.
git fetch --prune --no-write-fetch-head origin master "$backup_branch" 2>/dev/null ||
  git fetch --prune --no-write-fetch-head origin master
if git show-ref --verify --quiet "refs/remotes/origin/$backup_branch"; then
  if git show-ref --verify --quiet "refs/heads/$backup_branch"; then
    git switch "$backup_branch"
  else
    git switch --track -c "$backup_branch" "origin/$backup_branch"
  fi
  git branch --set-upstream-to="origin/$backup_branch" "$backup_branch" >/dev/null
  git merge --ff-only "origin/$backup_branch"
else
  git switch -c "$backup_branch" origin/master
fi

# A merge commit preserves each backup commit as an ancestor of master. Once the
# prior publication is merged, fast-forward the long-lived automation branch.
if git merge-base --is-ancestor "origin/$backup_branch" origin/master 2>/dev/null; then
  git merge --ff-only origin/master
fi

summary=$(node "$prepare_script" \
  "$export_file" \
  "$target_file" \
  "$metadata_file")
IFS=$'\t' read -r status record_count first_date last_date sha256 <<<"$summary"

if [[ "$status" == "unchanged" ]]; then
  echo "Personal-record backup is already current ($record_count records, SHA-256 $sha256)"
  last_date_iso=$(node -e 'console.log(new Date(Number(process.argv[1])).toISOString())' "$last_date")
  record_success "$record_count" "$last_date_iso" "$sha256"
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
  last_date_iso=$(node -e 'console.log(new Date(Number(process.argv[1])).toISOString())' "$last_date")
  record_success "$record_count" "$last_date_iso" "$sha256"
  exit 0
fi

last_date_iso=$(node -e 'console.log(new Date(Number(process.argv[1])).toISOString())' "$last_date")
git commit -m "Update personal match records ($record_count matches)"

for attempt in 1 2 3; do
  if git push origin "HEAD:$backup_branch"; then
    echo "Published $record_count personal records through $last_date_iso to $backup_branch"
    echo "GitHub will merge the backup into master after the verify check passes"
    record_success "$record_count" "$last_date_iso" "$sha256"
    exit 0
  fi
  if [[ "$attempt" -eq 3 ]]; then
    break
  fi
  echo "Remote backup branch changed during publication; rebasing and retrying ($attempt/3)"
  git fetch --prune --no-write-fetch-head origin "$backup_branch"
  git rebase "origin/$backup_branch"
done

echo "Unable to publish the personal-record backup after three attempts" >&2
exit 1
