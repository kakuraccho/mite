#!/bin/bash
# Run from the repository root after CI and the Linux binary build succeed.
set -euo pipefail

[[ "$#" -eq 1 && -f "$1" ]] || {
  printf 'Usage: bash server/deploy/deploy-from-ci.sh <mite-api binary>\n' >&2
  exit 1
}
binary="$1"
: "${GH_TOKEN:?GitHub token is required}"
: "${GITHUB_REPOSITORY:?GitHub repository is required}"
: "${GITHUB_REF:?GitHub branch reference is required}"
: "${GITHUB_SHA:?GitHub commit is required}"
: "${RUNNER_TEMP:?Runner temporary directory is required}"
: "${SUPABASE_DB_URL:?Set SUPABASE_DB_URL in the vps-mirai-server environment}"
: "${VPS_HOST:?Set VPS_HOST in the vps-mirai-server environment}"
: "${VPS_USER:?Set VPS_USER in the vps-mirai-server environment}"
: "${VPS_SSH_KEY:?Set VPS_SSH_KEY in the vps-mirai-server environment}"
: "${VPS_KNOWN_HOSTS:?Set VPS_KNOWN_HOSTS in the vps-mirai-server environment}"
VPS_SSH_PORT="${VPS_SSH_PORT:-22}"
[[ "$VPS_HOST" =~ ^[a-zA-Z0-9][a-zA-Z0-9.:-]*$ ]] || exit 1
[[ "$VPS_USER" =~ ^[a-zA-Z_][a-zA-Z0-9_-]*$ ]] || exit 1
[[ "$VPS_SSH_PORT" =~ ^[0-9]{1,5}$ ]] || exit 1
((10#$VPS_SSH_PORT >= 1 && 10#$VPS_SSH_PORT <= 65535)) || exit 1
[[ "$GITHUB_REF" == refs/heads/dev || "$GITHUB_REF" == refs/heads/main ]] || exit 1

require_current_commit() {
  local current_sha
  current_sha="$(gh api "repos/$GITHUB_REPOSITORY/git/ref/${GITHUB_REF#refs/}" --jq '.object.sha')"
  if [[ "$current_sha" != "$GITHUB_SHA" ]]; then
    printf '::notice::A newer commit exists on the deployment branch; skipping the remaining deployment steps.\n'
    exit 0
  fi
}
require_current_commit

umask 077
ssh_directory="$(mktemp -d "$RUNNER_TEMP/mite-ssh.XXXXXXXX")"
trap 'rm -rf -- "$ssh_directory"' EXIT
printf '%s\n' "$VPS_SSH_KEY" > "$ssh_directory/key"
printf '%s\n' "$VPS_KNOWN_HOSTS" > "$ssh_directory/known_hosts"
ssh_command=(ssh -F /dev/null -i "$ssh_directory/key"
  -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes
  -o UserKnownHostsFile="$ssh_directory/known_hosts"
  -o GlobalKnownHostsFile=/dev/null -o ConnectTimeout=10
  -o ServerAliveInterval=15 -o ServerAliveCountMax=3
  -p "$VPS_SSH_PORT" -l "$VPS_USER" "$VPS_HOST")
digest="$(sha256sum "$binary")"
digest="${digest%% *}"

# Check SSH access and the existing VPS deployment setup before changing the DB.
"${ssh_command[@]}" "test -x /usr/local/sbin/mite-deploy && systemctl is-active --quiet mite-api.service && sudo -n -l /usr/local/sbin/mite-deploy $digest >/dev/null"

# Only versioned SQL migrations are applied; Vault, seed and roles are excluded.
npx --no-install supabase db push --db-url "$SUPABASE_DB_URL" --skip-vault --dry-run
require_current_commit
npx --no-install supabase db push --db-url "$SUPABASE_DB_URL" --skip-vault --yes

# A new commit may arrive while the database is being migrated.
require_current_commit
"${ssh_command[@]}" "sudo -n /usr/local/sbin/mite-deploy $digest" < "$binary"
