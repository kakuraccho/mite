#!/bin/bash
# Exercise CI deployment ordering without GitHub, Supabase or VPS access.
set -euo pipefail

script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
test_root="$(mktemp -d)"
trap 'result=$?; if [[ "$result" != 0 && -f "${scenario_root:-}/output" ]]; then cat "$scenario_root/output"; fi; rm -rf -- "$test_root"' EXIT
mkdir "$test_root/bin"
cat > "$test_root/bin/stub" <<'BASH'
#!/bin/bash
set -euo pipefail
case "${0##*/}" in
  gh)
    printf 'check\n' >> "$scenario_root/calls"
    [[ "$scenario" != github-fails ]] || exit 1
    count=0
    [[ ! -f "$scenario_root/checks" ]] || read -r count < "$scenario_root/checks"
    count=$((count + 1))
    printf '%s\n' "$count" > "$scenario_root/checks"
    case "$scenario:$count" in
      stale-start:1|stale-after-plan:2|stale-after-migrate:3) printf 'newer-commit\n' ;;
      *) printf '%s\n' "$GITHUB_SHA" ;;
    esac
    ;;
  npx)
    [[ "$#" -eq 8 && "$1 $2 $3 $4 $5" == '--no-install supabase db push --db-url' ]]
    [[ "$6" == "$SUPABASE_DB_URL" && "$7" == --skip-vault ]]
    case "$8" in
      --dry-run)
        printf 'dry-run\n' >> "$scenario_root/calls"
        [[ "$scenario" != dry-run-fails ]]
        ;;
      --yes)
        printf 'migrate\n' >> "$scenario_root/calls"
        [[ "$scenario" != migration-fails ]]
        ;;
      *) exit 1 ;;
    esac
    ;;
  ssh)
    # Check that temporary credentials have private permissions.
    [[ "$1" == -F && "$2" == /dev/null && "$3" == -i ]]
    [[ "$(stat -c %a "$4")" == 600 ]]
    case "${*: -1}" in
      'test -x /usr/local/sbin/mite-deploy '* )
        printf 'preflight\n' >> "$scenario_root/calls"
        [[ "$scenario" != preflight-fails ]]
        ;;
      'sudo -n /usr/local/sbin/mite-deploy '* )
        printf 'deploy\n' >> "$scenario_root/calls"
        cmp -s - "$scenario_root/binary"
        [[ "$scenario" != deploy-fails ]]
        ;;
      *) exit 1 ;;
    esac
    ;;
esac
BASH
chmod 755 "$test_root/bin/stub"
for command in gh npx ssh; do
  ln -s stub "$test_root/bin/$command"
done

for scenario in success missing-secret invalid-port stale-start github-fails preflight-fails dry-run-fails stale-after-plan migration-fails stale-after-migrate deploy-fails; do
  scenario_root="$test_root/$scenario"
  mkdir "$scenario_root" "$scenario_root/temp"
  printf 'test-binary\n' > "$scenario_root/binary"
  : > "$scenario_root/calls"
  status=0
  (
    export scenario scenario_root
    export PATH="$test_root/bin:$PATH"
    export GH_TOKEN=test-github-token GITHUB_REPOSITORY=example/mite
    export GITHUB_REF=refs/heads/dev GITHUB_SHA=test-commit
    export RUNNER_TEMP="$scenario_root/temp"
    export SUPABASE_DB_URL='postgresql://postgres:test-password@db.example:5432/postgres?sslmode=require'
    export VPS_HOST=vps.example VPS_USER=deployer VPS_SSH_PORT=22
    export VPS_SSH_KEY=test-ssh-key VPS_KNOWN_HOSTS=test-known-hosts
    case "$scenario" in
      missing-secret) unset SUPABASE_DB_URL ;;
      invalid-port) export VPS_SSH_PORT=65536 ;;
    esac
    bash "$script_directory/deploy-from-ci.sh" "$scenario_root/binary"
  ) > "$scenario_root/output" 2>&1 || status="$?"

  expected_status=1
  case "$scenario" in
    success|stale-start|stale-after-plan|stale-after-migrate) expected_status=0 ;;
  esac
  if [[ "$expected_status" -eq 0 ]]; then
    [[ "$status" -eq 0 ]]
  else
    [[ "$status" -ne 0 ]]
  fi
  expected=()
  case "$scenario" in
    missing-secret|invalid-port) ;;
    stale-start|github-fails) expected=(check) ;;
    preflight-fails) expected=(check preflight) ;;
    dry-run-fails) expected=(check preflight dry-run) ;;
    stale-after-plan) expected=(check preflight dry-run check) ;;
    migration-fails) expected=(check preflight dry-run check migrate) ;;
    stale-after-migrate) expected=(check preflight dry-run check migrate check) ;;
    success|deploy-fails) expected=(check preflight dry-run check migrate check deploy) ;;
  esac
  : > "$scenario_root/expected"
  if [[ "${#expected[@]}" -gt 0 ]]; then
    printf '%s\n' "${expected[@]}" > "$scenario_root/expected"
  fi
  diff -u "$scenario_root/expected" "$scenario_root/calls"
  shopt -s nullglob
  leftovers=("$scenario_root/temp"/mite-ssh.*)
  [[ "${#leftovers[@]}" -eq 0 ]]
  printf 'PASS %s\n' "$scenario"
done
