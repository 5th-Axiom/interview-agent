#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

staging_root=/home/deploy/interview-agent
staging_url=https://test.interview.energylt.com
staging_relay=wss://test.interview.energylt.com/ws
for command in docker python3 flock curl tar; do command -v "$command" >/dev/null; done
docker info >/dev/null
docker compose version >/dev/null
test -d "$staging_root/shared"
if [[ -e "$staging_root/current" && ! -L "$staging_root/current" ]]; then
  echo 'The current release pointer must be a symlink.' >&2; exit 1
fi
python3 - "$staging_root" "$staging_url" "$staging_relay" <<'PY'
import pathlib, stat, sys
root = pathlib.Path(sys.argv[1])
for name in ('app.env', 'deploy.env'):
    path = root / 'shared' / name
    if not path.is_file() or stat.S_IMODE(path.stat().st_mode) & 0o077:
        sys.exit(f'{name} must exist and be private (0600).')
def read_env(name):
    values = {}
    for line in (root / 'shared' / name).read_text().splitlines():
        key, separator, value = line.partition('=')
        if separator:
            values[key.strip()] = value.strip().strip('"\'')
    return values
values = read_env('app.env')
for key, expected in [('APP_ENV', 'staging'), ('APP_URL', sys.argv[2]), ('NEXT_PUBLIC_RELAY_URL', sys.argv[3])]:
    if values.get(key) != expected:
        sys.exit(f'Staging {key} does not match this deployment target.')
deployment = read_env('deploy.env')
if deployment.get('INTERVIEW_ENV_FILE') != str(root / 'shared/app.env'):
    sys.exit('INTERVIEW_ENV_FILE must point to this project shared/app.env.')
for key in ('INTERVIEW_IMAGE', 'INTERVIEW_DB_PASSWORD', 'INTERVIEW_STORAGE_USER', 'INTERVIEW_STORAGE_PASSWORD'):
    if not deployment.get(key):
        sys.exit(f'Missing deployment {key}.')
if sum(line.startswith('INTERVIEW_IMAGE=') for line in (root / 'shared/deploy.env').read_text().splitlines()) != 1:
    sys.exit('deploy.env must contain exactly one INTERVIEW_IMAGE entry.')
print('SSH, Docker, private configuration and domain target checked.')
PY
if [[ "${1:-}" == --check ]]; then exit 0; fi

revision="${1:-}"
if [[ ! "$revision" =~ ^[a-f0-9]{40}$ ]]; then echo 'Invalid revision.' >&2; exit 2; fi
release="$staging_root/releases/$revision"
staging_image="interview-agent:$revision"
cd "$release"
compose() {
  INTERVIEW_IMAGE="$staging_image" docker compose \
    --env-file "$staging_root/shared/deploy.env" -f deploy/compose.staging.yaml "$@"
}
trap 'echo "Deployment failed; inspect the error above. Previous images and data are retained. See docs/staging.md for recovery." >&2' ERR

echo 'Building release image...'
docker build --build-arg NODE_IMAGE=docker.m.daocloud.io/library/node:24-slim \
  --build-arg NEXT_PUBLIC_RELAY_URL="$staging_relay" \
  --label "org.opencontainers.image.revision=$revision" \
  -f deploy/Dockerfile -t "$staging_image" .
echo 'Validating application configuration before replacing services...'
compose run --rm --no-deps web node --env-file=.env.local --import tsx --input-type=module \
  -e 'const { validateEnvironment } = await import("./server/config.ts"); validateEnvironment();'
echo 'Applying migrations and ensuring seed roles / private storage...'
compose up -d --wait --wait-timeout 90 postgres storage
# Stop old writers before changing the schema or enabling a new audio storage format.
# Keep database/object services and their volumes running throughout the upgrade.
echo 'Stopping application writers before migration...'
compose stop --timeout 45 web relay worker
compose run --rm --no-deps web npm run db:migrate
compose run --rm --no-deps web npm run db:seed
echo 'Updating Web, Relay and Worker...'
compose up -d --wait --wait-timeout 120

check_status() {
  local actual
  actual="$(curl --silent --show-error --connect-timeout 5 --max-time 10 \
    -H "Host: test.interview.energylt.com" -H "X-Forwarded-Proto: https" \
    -o /dev/null -w '%{http_code}' "http://127.0.0.1$1")"
  if [[ "$actual" != "$2" ]]; then
    echo "Origin check failed for $1: expected $2, received $actual" >&2
    return 1
  fi
}
check_status /healthz 200
check_status /interview 307
check_status /api/config 401

# Persist the selected image only after service and HTTPS checks succeed.
python3 - "$staging_root" "$staging_image" <<'PY'
import os, pathlib, re, sys, tempfile
path = pathlib.Path(sys.argv[1]) / 'shared/deploy.env'
contents, count = re.subn(r'^INTERVIEW_IMAGE=.*$', 'INTERVIEW_IMAGE=' + sys.argv[2], path.read_text(), flags=re.M)
if count != 1:
    sys.exit('deploy.env must contain exactly one INTERVIEW_IMAGE entry.')
fd, temporary = tempfile.mkstemp(dir=path.parent, prefix='.deploy-')
try:
    with os.fdopen(fd, 'w') as output:
        output.write(contents)
    os.replace(temporary, path)
finally:
    if os.path.exists(temporary):
        os.unlink(temporary)
PY
ln -sfn "$release" "$staging_root/current"
compose ps --format 'table {{.Service}}\t{{.Image}}\t{{.Status}}'
echo 'Origin health, page protection and API protection passed; public TLS is checked separately.'
