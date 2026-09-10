#!/bin/bash
# Exercise family PWA CI orchestration without GitHub or VPS access.
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
    if [[ "$scenario" == stale-start && "$count" -eq 1 ]] ||
       [[ "$scenario" == stale-after-preflight && "$count" -eq 2 ]]; then
      printf '%040d\n' 2
    else
      printf '%s\n' "$GITHUB_SHA"
    fi
    ;;
  ssh)
    [[ "$1" == -F && "$2" == /dev/null && "$3" == -i ]]
    [[ "$(stat -c %a "$4")" == 600 ]]
    case "${*: -1}" in
      'test -x /usr/local/bin/mite-pwa-deploy && /usr/local/bin/mite-pwa-deploy --check '*)
        printf 'preflight\n' >> "$scenario_root/calls"
        [[ "${*: -1}" =~ [0-9a-f]{64}$ ]]
        [[ "$scenario" != preflight-fails ]]
        ;;
      '/usr/local/bin/mite-pwa-deploy '*)
        printf 'deploy\n' >> "$scenario_root/calls"
        [[ "${*: -1}" =~ ^/usr/local/bin/mite-pwa-deploy\ [0-9a-f]{64}\ [0-9a-f]{64}\ [0-9a-f]{40}$ ]]
        cmp -s - "$scenario_root/archive"
        [[ "$scenario" != deploy-fails ]]
        ;;
      *) exit 1 ;;
    esac
    ;;
esac
BASH
chmod 755 "$test_root/bin/stub"
for command in gh ssh; do
  ln -s stub "$test_root/bin/$command"
done

for scenario in success missing-secret invalid-port invalid-sha stale-start github-fails preflight-fails stale-after-preflight deploy-fails; do
  scenario_root="$test_root/$scenario"
  mkdir "$scenario_root" "$scenario_root/temp"
  printf 'test-pwa-archive\n' > "$scenario_root/archive"
  : > "$scenario_root/calls"
  status=0
  (
    export scenario scenario_root
    export PATH="$test_root/bin:$PATH"
    export GH_TOKEN=test-github-token GITHUB_REPOSITORY=example/mite
    export GITHUB_REF=refs/heads/dev
    export GITHUB_SHA=1111111111111111111111111111111111111111
    export RUNNER_TEMP="$scenario_root/temp"
    export VPS_HOST=vps.example VPS_USER=deployer VPS_SSH_PORT=22
    export VPS_SSH_KEY=test-ssh-key VPS_KNOWN_HOSTS=test-known-hosts
    case "$scenario" in
      missing-secret) unset VPS_HOST ;;
      invalid-port) export VPS_SSH_PORT=65536 ;;
      invalid-sha) export GITHUB_SHA=not-a-commit ;;
    esac
    bash "$script_directory/deploy-pwa-from-ci.sh" "$scenario_root/archive"
  ) > "$scenario_root/output" 2>&1 || status="$?"

  expected_status=1
  case "$scenario" in
    success|stale-start|stale-after-preflight) expected_status=0 ;;
  esac
  if [[ "$expected_status" -eq 0 ]]; then
    [[ "$status" -eq 0 ]]
  else
    [[ "$status" -ne 0 ]]
  fi
  expected=()
  case "$scenario" in
    missing-secret|invalid-port|invalid-sha) ;;
    stale-start|github-fails) expected=(check) ;;
    preflight-fails) expected=(check preflight) ;;
    stale-after-preflight) expected=(check preflight check) ;;
    success|deploy-fails) expected=(check preflight check deploy) ;;
  esac
  : > "$scenario_root/expected"
  if [[ "${#expected[@]}" -gt 0 ]]; then
    printf '%s\n' "${expected[@]}" > "$scenario_root/expected"
  fi
  diff -u "$scenario_root/expected" "$scenario_root/calls"
  shopt -s nullglob
  leftovers=("$scenario_root/temp"/mite-pwa-ssh.*)
  [[ "${#leftovers[@]}" -eq 0 ]]
  printf 'PASS %s\n' "$scenario"
done
