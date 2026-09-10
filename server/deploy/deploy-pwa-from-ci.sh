#!/bin/bash
# Run from the repository root after the family PWA production build succeeds.
set -euo pipefail

[[ "$#" -eq 1 && -f "$1" ]] || {
  printf 'Usage: bash server/deploy/deploy-pwa-from-ci.sh <family-pwa.tar.gz>\n' >&2
  exit 1
}
archive="$1"
script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
: "${GH_TOKEN:?GitHub token is required}"
: "${GITHUB_REPOSITORY:?GitHub repository is required}"
: "${GITHUB_REF:?GitHub branch reference is required}"
: "${GITHUB_SHA:?GitHub commit is required}"
: "${RUNNER_TEMP:?Runner temporary directory is required}"
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
[[ "$GITHUB_SHA" =~ ^[0-9a-f]{40}$ ]] || exit 1

require_current_commit() {
  local current_sha
  current_sha="$(gh api "repos/$GITHUB_REPOSITORY/git/ref/${GITHUB_REF#refs/}" --jq '.object.sha')"
  if [[ "$current_sha" != "$GITHUB_SHA" ]]; then
    printf '::notice::A newer commit exists on the deployment branch; skipping the family PWA deployment.\n'
    exit 0
  fi
}
require_current_commit

umask 077
ssh_directory="$(mktemp -d "$RUNNER_TEMP/mite-pwa-ssh.XXXXXXXX")"
trap 'rm -rf -- "$ssh_directory"' EXIT
printf '%s\n' "$VPS_SSH_KEY" > "$ssh_directory/key"
printf '%s\n' "$VPS_KNOWN_HOSTS" > "$ssh_directory/known_hosts"
ssh_command=(ssh -F /dev/null -i "$ssh_directory/key"
  -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes
  -o UserKnownHostsFile="$ssh_directory/known_hosts"
  -o GlobalKnownHostsFile=/dev/null -o ConnectTimeout=10
  -o ServerAliveInterval=15 -o ServerAliveCountMax=3
  -p "$VPS_SSH_PORT" -l "$VPS_USER" "$VPS_HOST")
remote_script=/usr/local/bin/mite-pwa-deploy
script_digest="$(sha256sum "$script_directory/mite-pwa-deploy.sh")"
script_digest="${script_digest%% *}"
archive_digest="$(sha256sum "$archive")"
archive_digest="${archive_digest%% *}"

if ! "${ssh_command[@]}" \
  "if test -x $remote_script; then $remote_script --check $script_digest; else printf '%s\n' 'Missing or non-executable $remote_script. Install server/deploy/mite-pwa-deploy.sh on the VPS.' >&2; exit 1; fi"; then
  printf '::error::Family PWA preflight failed. Complete the Apache and PWA VPS setup in docs/ci-cd.md.\n' >&2
  exit 1
fi

require_current_commit
"${ssh_command[@]}" \
  "$remote_script $script_digest $archive_digest $GITHUB_SHA" < "$archive"
