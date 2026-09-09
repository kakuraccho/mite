#!/bin/bash
# Exercise installation and recovery against temporary files, without sudo,
# systemd, network access, or changes to /opt/mite.
set -euo pipefail

script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
test_root="$(mktemp -d)"
trap 'result=$?; if [[ "$result" != 0 && -f "${directory:-}/output" ]]; then cat "$directory/output"; fi; rm -rf -- "$test_root"' EXIT

cat > "$test_root/scenario.sh" <<'BASH'
set -euo pipefail
source "$1"
scenario="$2"
directory="$3"
digest="$4"

# These stand in for the VPS process and HTTP response; filesystem operations,
# checksums, flock, signal handling, and rollback run unchanged.
mite_service_ready() {
  [[ "$scenario" != unhealthy-before ]] || return 1
  if [[ "$scenario" == unhealthy-after* ]] && cmp -s "$1" "$directory/new"; then
    return 1
  fi
  if [[ "$scenario" == interrupted ]] && cmp -s "$1" "$directory/new"; then
    kill -TERM "$BASHPID"
    return 1
  fi
  # Reproduce the incident: the old binary requires v1 and the new one v2.
  # Before the first managed deployment, v1 comes from the existing .env.
  local environment='AI_PROMPT_VERSION=v1' expected='AI_PROMPT_VERSION=v1'
  [[ ! -f "$directory/mite-api.env" ]] || environment="$(cat "$directory/mite-api.env")"
  if cmp -s "$1" "$directory/new"; then
    expected='AI_PROMPT_VERSION=v2'
  fi
  [[ "$environment" == "$expected" ]]
}
systemctl() {
  if [[ "$*" == 'show --property EnvironmentFiles --value mite-api.service' ]]; then
    [[ "$scenario" != missing-environment-file ]] || return 0
    printf '%s/mite-api.env (ignore_errors=yes)\n' "$directory"
    return 0
  fi
  [[ "$*" == "restart mite-api.service" ]]
  printf 'restart\n' >> "$directory/restarts"
  if [[ "$scenario" == restart-fails ]] && cmp -s "$directory/mite-api" "$directory/new"; then
    return 1
  fi
}
mv() {
  if [[ "$scenario" == environment-install-fails && "$*" == *'.mite-api.env.incoming.'* ]]; then
    return 1
  fi
  command mv "$@"
}
sleep() { :; }

prompt_version=v2
[[ "$scenario" != invalid-version ]] || prompt_version='v2; false'
mite_install "$directory" "$directory/deploy.lock" "$digest" "$prompt_version" < "$directory/new"
BASH

for scenario in success success-no-override checksum-mismatch unhealthy-before unhealthy-after unhealthy-after-no-override restart-fails interrupted locked missing-environment-file invalid-version environment-install-fails; do
  directory="$test_root/$scenario"
  mkdir "$directory"
  printf 'old-binary\n' > "$directory/old"
  printf 'new-binary\n' > "$directory/new"
  cp "$directory/old" "$directory/mite-api"
  chmod 755 "$directory/mite-api"
  if [[ "$scenario" != *-no-override ]]; then
    printf 'AI_PROMPT_VERSION=v1\n' > "$directory/mite-api.env"
    chmod 600 "$directory/mite-api.env"
  fi
  digest="$(sha256sum "$directory/new")"
  digest="${digest%% *}"
  if [[ "$scenario" == checksum-mismatch ]]; then
    digest="$(sha256sum "$directory/old")"
    digest="${digest%% *}"
  fi
  if [[ "$scenario" == locked ]]; then
    exec 8>"$directory/deploy.lock"
    flock -n 8
  fi

  status=0
  bash "$test_root/scenario.sh" "$script_directory/mite-deploy.sh" "$scenario" "$directory" "$digest" \
    > "$directory/output" 2>&1 || status="$?"
  if [[ "$scenario" == locked ]]; then
    exec 8>&-
  fi

  if [[ "$scenario" == success* ]]; then
    [[ "$status" -eq 0 ]]
    cmp "$directory/mite-api" "$directory/new"
    cmp "$directory/mite-api.previous" "$directory/old"
    [[ "$(stat -c %a "$directory/mite-api")" == 755 ]]
    [[ "$(wc -l < "$directory/restarts")" -eq 1 ]]
    [[ "$(cat "$directory/mite-api.env")" == 'AI_PROMPT_VERSION=v2' ]]
    [[ "$(stat -c %a "$directory/mite-api.env")" == 600 ]]
  else
    [[ "$status" -ne 0 ]]
    cmp "$directory/mite-api" "$directory/old"
    case "$scenario" in
      unhealthy-after*|restart-fails|interrupted)
        [[ "$(wc -l < "$directory/restarts")" -eq 2 ]]
        ;;
      environment-install-fails)
        [[ "$(wc -l < "$directory/restarts")" -eq 1 ]]
        ;;
      *)
        [[ ! -e "$directory/restarts" ]]
        ;;
    esac
    if [[ "$scenario" == *-no-override ]]; then
      [[ ! -e "$directory/mite-api.env" ]]
    else
      [[ "$(cat "$directory/mite-api.env")" == 'AI_PROMPT_VERSION=v1' ]]
      [[ "$(stat -c %a "$directory/mite-api.env")" == 600 ]]
    fi
  fi
  shopt -s nullglob
  leftovers=("$directory"/.mite-api.*)
  [[ "${#leftovers[@]}" -eq 0 ]]
  printf 'PASS %s\n' "$scenario"
done

# Verify that readiness rejects HTTP errors and processes running another file.
(
  source "$script_directory/mite-deploy.sh"
  # Command substitution has its own BASHPID; use the parent process explicitly.
  probe_pid="$BASHPID"
  systemctl() {
    case "$1" in
      is-active) return 0 ;;
      show) printf '%s\n' "$probe_pid" ;;
    esac
  }
  curl() { printf '%s' "$probe_status"; }
  probe_status=401
  mite_service_ready /bin/bash
  probe_status=500
  if mite_service_ready /bin/bash; then
    exit 1
  fi
  probe_status=401
  if mite_service_ready "$test_root/success/mite-api"; then
    exit 1
  fi
)
printf 'PASS readiness status and process identity\n'

# Reject a missing, non-optional or overridden EnvironmentFile before installation.
(
  source "$script_directory/mite-deploy.sh"
  systemctl() { printf '%s\n' "$environment_files"; }
  directory="$test_root/environment-check"
  mkdir "$directory"
  for environment_files in '' "$directory/mite-api.env (ignore_errors=no)" "$directory/mite-api.env (ignore_errors=yes) /etc/other.env (ignore_errors=yes)"; do
    if mite_check_environment_file "$directory" 2>/dev/null; then
      exit 1
    fi
  done
  environment_files="$directory/mite-api.env (ignore_errors=yes)"
  mite_check_environment_file "$directory"
  ln -s "$test_root/success/mite-api.env" "$directory/mite-api.env"
  if mite_check_environment_file "$directory" 2>/dev/null; then
    exit 1
  fi
)
printf 'PASS deployment environment preflight\n'
