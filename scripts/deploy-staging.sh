#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd "$(dirname "$0")/.." && pwd)"
cd "$project_dir"
case "${1:-}" in
  --help|-h)
    echo 'npm run deploy:staging           Deploy committed HEAD to ssh cd'
    echo 'npm run deploy:staging -- --check Check SSH and server prerequisites only'
    exit 0 ;;
  --check|'') ;;
  *) echo 'Unknown argument; use --help.' >&2; exit 2 ;;
esac
if [[ $# -gt 1 ]]; then echo 'Too many arguments.' >&2; exit 2; fi

if [[ "${1:-}" != --check ]] && [[ -n "$(git status --porcelain)" ]]; then
  echo 'Commit or stash local changes first; deployment only uploads committed HEAD.' >&2
  exit 1
fi
revision="$(git rev-parse --verify HEAD)"
if [[ ! "$revision" =~ ^[a-f0-9]{40}$ ]]; then
  echo 'Invalid Git revision.' >&2; exit 1
fi

echo 'Checking staging prerequisites via ssh cd...'
ssh -o BatchMode=yes -o ConnectTimeout=10 cd 'bash -s -- --check' < deploy/staging-release.sh
if [[ "${1:-}" == --check ]]; then exit 0; fi

archive="$(mktemp "${TMPDIR:-/tmp}/interview-staging.XXXXXX")"
trap 'rm -f "$archive"' EXIT
git archive --format=tar "$revision" > "$archive"
echo "Deploying committed version ${revision:0:12}..."
# The validated revision is the only interpolation in this remote shell command.
# Hold the project lock across upload, build, migration, and service replacement.
ssh -o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=15 cd "
set -euo pipefail
umask 077
root=/home/deploy/interview-agent
exec 9>\"\$root/shared/deploy.lock\"
flock -n 9 || { echo 'Another staging deployment is running.' >&2; exit 1; }
release=\"\$root/releases/$revision\"
umask 022
mkdir -p \"\$release\"
tar -xf - -C \"\$release\"
bash \"\$release/deploy/staging-release.sh\" '$revision'
" < "$archive"

echo "Deployed ${revision:0:12}: https://47.108.226.96:9443"
if ! curl --fail --silent --show-error --connect-timeout 5 --max-time 8 \
  https://47.108.226.96:9443/healthz >/dev/null 2>&1; then
  echo 'Server checks passed, but public HTTPS is unreachable from this network. Check TCP 9443 ingress.' >&2
fi
