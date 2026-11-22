#!/usr/bin/env bash
# Production deploy for the main checkout that the systemd units run from.
#
#   npm run deploy                    # deploy origin/main
#   npm run deploy -- --dry-run       # print what would happen, change nothing
#   npm run deploy -- --restart-all   # restart every unit, not only the changed ones
#   npm run deploy -- --smoke-only    # only run the smoke checks
#
# Order (docs/ENVIRONMENTS.md, docs/BACKUP_RESTORE.md): preconditions -> backup
# -> fast-forward -> npm ci (lockfile changed) -> build -> restart changed units
# -> smoke checks. Announcing the deploy to other agents is not part of this
# script.
#
# Everything host-specific is an environment variable with a default:
#   FINANCE_APP_DIR        checkout to deploy (default: the one holding this script)
#   FINANCE_DB             real database      (default: $HOME/finance-app-data/finance.db)
#   FINANCE_BACKUP_DIR     backup directory   (default: $HOME/finance-backups)
#   FINANCE_BACKUP_KEEP    backups to keep    (default: 30)
#   FINANCE_UNIT_PREFIX    systemd units are <prefix>-api/-web/-mcp (default: finance-app)
#   FINANCE_API_URL        (default: http://127.0.0.1:3001)
#   FINANCE_WEB_URL        (default: http://127.0.0.1:5173)
#   FINANCE_MCP_URL        (default: https://<hostname>:3030/mcp; the name must be in the certificate)
#   FINANCE_MCP_CONNECT_TO curl --connect-to for MCP (default: ::127.0.0.1:, i.e. connect over
#                          loopback but verify the certificate against the URL's host name)
#   FINANCE_MCP_CA         (default: $HOME/.config/finance-mcp/server.crt)
#   FINANCE_MCP_TOKEN_FILE (default: $HOME/.config/finance-mcp/token)
#   FINANCE_SMOKE_TIMEOUT  seconds to wait for each service after a restart (default: 60)
set -euo pipefail

DRY_RUN=0
RESTART_ALL=0
SMOKE_ONLY=0
for arg in "$@"; do
	case "$arg" in
	--dry-run) DRY_RUN=1 ;;
	--restart-all) RESTART_ALL=1 ;;
	--smoke-only) SMOKE_ONLY=1 ;;
	-h | --help)
		sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'
		exit 0
		;;
	*)
		echo "deploy: unknown option '$arg' (see --help)" >&2
		exit 2
		;;
	esac
done

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ROOT="${FINANCE_APP_DIR:-$(git -C "$script_dir" rev-parse --show-toplevel)}"
DB="${FINANCE_DB:-$HOME/finance-app-data/finance.db}"
BACKUP_DIR="${FINANCE_BACKUP_DIR:-$HOME/finance-backups}"
BACKUP_KEEP="${FINANCE_BACKUP_KEEP:-30}"
UNIT_PREFIX="${FINANCE_UNIT_PREFIX:-finance-app}"
API_URL="${FINANCE_API_URL:-http://127.0.0.1:3001}"
WEB_URL="${FINANCE_WEB_URL:-http://127.0.0.1:5173}"
MCP_URL="${FINANCE_MCP_URL:-https://$(hostname):3030/mcp}"
MCP_CONNECT_TO="${FINANCE_MCP_CONNECT_TO-::127.0.0.1:}"
MCP_CA="${FINANCE_MCP_CA:-$HOME/.config/finance-mcp/server.crt}"
MCP_TOKEN_FILE="${FINANCE_MCP_TOKEN_FILE:-$HOME/.config/finance-mcp/token}"
SMOKE_TIMEOUT="${FINANCE_SMOKE_TIMEOUT:-60}"

log() { echo "deploy: $*"; }
fail() {
	echo "deploy: FAILED: $*" >&2
	exit 1
}
# Preconditions refuse a real run; a dry run reports every refusal and goes on.
REFUSALS=0
refuse() {
	if [ "$DRY_RUN" = 1 ]; then
		echo "deploy: WOULD REFUSE: $*" >&2
		REFUSALS=$((REFUSALS + 1))
	else
		fail "$*"
	fi
}
# run: execute, or only print in a dry run.
run() {
	if [ "$DRY_RUN" = 1 ]; then
		echo "deploy: [dry-run] would run: $*"
	else
		"$@"
	fi
}

cd "$ROOT"

# ---------------------------------------------------------------- smoke checks

# Polls until the check passes or the timeout runs out; returns the last result.
wait_for() {
	local what=$1
	shift
	local deadline=$((SECONDS + SMOKE_TIMEOUT))
	until "$@"; do
		if [ "$SECONDS" -ge "$deadline" ]; then
			echo "deploy: smoke: $what did not pass within ${SMOKE_TIMEOUT}s" >&2
			return 1
		fi
		sleep 2
	done
	log "smoke: $what ok"
}

check_api() {
	curl -fsS --max-time 5 "$API_URL/health" 2>/dev/null | grep -q '"status":"ok"' &&
		# The production API must serve the real database, never the demo.
		curl -fsS --max-time 5 "$API_URL/data-status" 2>/dev/null | grep -q '"dataset":"real"'
}

check_web() {
	[ "$(curl -s -o /dev/null --max-time 5 -w '%{http_code}' "$WEB_URL/" || true)" = 200 ] &&
		# The web server's /api proxy reaches the API.
		curl -fsS --max-time 5 "$WEB_URL/api/health" 2>/dev/null | grep -q '"status":"ok"'
}

# End to end: MCP -> API -> database with a read-only tool. The MCP server
# refuses every tool against the demo database, so success also means real
# data. The token goes to curl through a file descriptor, never argv or output;
# the response holds real data and is only inspected, never printed.
check_mcp() {
	[ -r "$MCP_TOKEN_FILE" ] || {
		echo "deploy: smoke: MCP token file not readable" >&2
		return 1
	}
	local connect=() body
	[ -n "$MCP_CONNECT_TO" ] && connect=(--connect-to "$MCP_CONNECT_TO")
	body=$(curl -sS --max-time 15 --cacert "$MCP_CA" "${connect[@]}" \
		-H @<(printf 'Authorization: Bearer %s\n' "$(tr -d '[:space:]' <"$MCP_TOKEN_FILE")") \
		-H 'Content-Type: application/json' \
		-H 'Accept: application/json, text/event-stream' \
		-d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_accounts","arguments":{}}}' \
		"$MCP_URL" 2>/dev/null) || return 1
	# Streamable HTTP answers either as JSON or as an SSE "data:" line.
	printf '%s\n' "$body" | sed -n 's/^data: //p; /^{/p' | head -n 1 |
		node -e '
			let s = "";
			process.stdin.on("data", (c) => (s += c)).on("end", () => {
				try {
					const r = JSON.parse(s).result;
					process.exit(r && Array.isArray(r.content) && !r.isError ? 0 : 1);
				} catch {
					process.exit(1);
				}
			});'
}

SMOKE_RESULT=""
smoke() {
	if [ "$DRY_RUN" = 1 ]; then
		log "[dry-run] would check: $API_URL/health + /data-status (dataset real), $WEB_URL/ + /api/health, MCP $MCP_URL tools/call list_accounts"
		SMOKE_RESULT="not run (dry run)"
		return 0
	fi
	local ok=1
	wait_for "API" check_api || ok=0
	wait_for "web" check_web || ok=0
	wait_for "MCP end to end" check_mcp || ok=0
	if [ "$ok" = 1 ]; then SMOKE_RESULT="ok (API, web, MCP)"; else SMOKE_RESULT="FAILED"; fi
	[ "$ok" = 1 ]
}

if [ "$SMOKE_ONLY" = 1 ]; then
	smoke || fail "smoke checks failed"
	log "smoke: $SMOKE_RESULT"
	exit 0
fi

# --------------------------------------------------------------- preconditions

[ "$DRY_RUN" = 1 ] && log "DRY RUN: nothing is changed (only 'git fetch' updates origin/main)"

[ "$(git rev-parse --show-toplevel)" = "$(pwd -P)" ] || refuse "$ROOT is not the root of a git checkout"
# A linked worktree has its own git dir; systemd runs the main checkout.
[ "$(git rev-parse --path-format=absolute --git-dir)" = "$(git rev-parse --path-format=absolute --git-common-dir)" ] ||
	refuse "$ROOT is a linked worktree, not the main checkout"
api_wd=$(systemctl show -p WorkingDirectory --value "$UNIT_PREFIX-api.service" 2>/dev/null || true)
[ "$api_wd" = "$ROOT/apps/api" ] ||
	refuse "$UNIT_PREFIX-api.service runs from '${api_wd:-?}', not from $ROOT/apps/api"

branch=$(git rev-parse --abbrev-ref HEAD)
[ "$branch" = main ] || refuse "checkout is on '$branch', expected main"
# Tracked changes would be lost or deployed half-way; untracked files (other
# agents' notes, plans) are left alone.
dirty=$(git status --porcelain --untracked-files=no)
[ -z "$dirty" ] || refuse "checkout has uncommitted changes to tracked files:
$dirty"

# One deploy at a time; the lock is released when this script exits.
if [ "$DRY_RUN" = 0 ]; then
	exec 9>"$(git rev-parse --path-format=absolute --git-common-dir)/finance-deploy.lock"
	flock -n 9 || fail "another deploy is running"
	sudo -n systemctl --version >/dev/null 2>&1 ||
		fail "cannot run 'sudo -n systemctl' (the units are system units; passwordless sudo is needed)"
fi

git fetch --quiet origin main
old=$(git rev-parse HEAD)
# Pin the target now; a later fetch must not change what is deployed.
new=$(git rev-parse origin/main)
git merge-base --is-ancestor "$old" "$new" ||
	refuse "HEAD ${old:0:7} is not an ancestor of origin/main ${new:0:7}; fast-forward impossible"

if [ "$old" = "$new" ] && [ "$RESTART_ALL" = 0 ]; then
	log "already at origin/main ${new:0:7}; nothing to deploy"
	smoke || fail "smoke checks failed on the running version"
	log "smoke: $SMOKE_RESULT"
	[ "$REFUSALS" = 0 ] || exit 3
	exit 0
fi

changed=$(git diff --name-only "$old" "$new")
log "deploying ${old:0:7} -> ${new:0:7} ($(git rev-list --count "$old..$new") commits)"
git --no-pager log --oneline "$old..$new" | sed 's/^/deploy:   /'

lock_changed=0
if ! git diff --quiet "$old" "$new" -- package-lock.json; then lock_changed=1; fi
needs_ci=$lock_changed
[ -d node_modules ] || needs_ci=1

# Which units run code from the changed paths. Shared code, dependencies and
# root config reach all of them.
units=()
if [ "$RESTART_ALL" = 1 ] || grep -qE '^(packages/|package(-lock)?\.json$|tsconfig[^/]*\.json$)' <<<"$changed"; then
	units=(api web mcp)
else
	grep -q '^apps/api/' <<<"$changed" && units+=(api)
	grep -q '^apps/web/' <<<"$changed" && units+=(web)
	grep -q '^apps/mcp/' <<<"$changed" && units+=(mcp)
fi

if [ "$DRY_RUN" = 1 ] && [ "$REFUSALS" -gt 0 ]; then
	log "[dry-run] $REFUSALS precondition(s) would stop a real run here; showing the remaining steps anyway"
fi

# ---------------------------------------------------------------------- backup

backup_path="not made (dry run)"
log "backup: $DB -> $BACKUP_DIR (keep $BACKUP_KEEP)"
if [ "$DRY_RUN" = 1 ]; then
	run sh -c "cd apps/api && NODE_OPTIONS=--experimental-sqlite ../../node_modules/.bin/tsx scripts/backup.ts --db '$DB' --dir '$BACKUP_DIR' --keep $BACKUP_KEEP"
else
	backup_out=$(cd apps/api && NODE_OPTIONS=--experimental-sqlite ../../node_modules/.bin/tsx scripts/backup.ts \
		--db "$DB" --dir "$BACKUP_DIR" --keep "$BACKUP_KEEP") || fail "backup failed; nothing was changed"
	printf '%s\n' "$backup_out" | sed 's/^/deploy:   /'
	backup_path=$(printf '%s\n' "$backup_out" | sed -n 's/^OK: wrote backup \(.*\) ([0-9]* bytes)$/\1/p')
	[ -n "$backup_path" ] && [ -s "$backup_path" ] || fail "backup reported no file; nothing was changed"
fi

# --------------------------------------------------------------- update + build

# After the merge the build output is replaced (each workspace's prebuild
# deletes dist/), so a failure here puts the previous commit and its build back
# before anything is restarted: a crash restart must find runnable code.
rollback() {
	echo "deploy: $1 at ${new:0:7}; rolling back to ${old:0:7}" >&2
	git reset --quiet --hard "$old"
	if [ "$lock_changed" = 1 ]; then npm ci || echo "deploy: npm ci of ${old:0:7} failed too" >&2; fi
	if npm run build; then
		fail "$1; checkout back at ${old:0:7}, rebuilt, nothing restarted"
	fi
	fail "$1, and rebuilding ${old:0:7} failed too: the units must NOT be restarted until 'npm run build' passes in $ROOT"
}

run git merge --quiet --ff-only "$new"
if [ "$needs_ci" = 1 ]; then
	log "npm ci ($([ "$lock_changed" = 1 ] && echo 'package-lock.json changed' || echo 'node_modules missing'))"
	if [ "$DRY_RUN" = 1 ]; then run npm ci; else npm ci || rollback "npm ci failed"; fi
else
	log "package-lock.json unchanged; skipping npm ci"
fi
if [ "$DRY_RUN" = 1 ]; then run npm run build; else npm run build || rollback "build failed"; fi

# --------------------------------------------------------------------- restart

restarted="none"
if [ "${#units[@]}" -gt 0 ]; then
	full_units=()
	for u in "${units[@]}"; do full_units+=("$UNIT_PREFIX-$u.service"); done
	# The API first: web and MCP depend on it.
	for unit in "${full_units[@]}"; do
		log "restart $unit"
		run sudo -n systemctl restart "$unit" || fail "restart of $unit failed (checkout is at ${new:0:7}, backup: $backup_path)"
	done
	restarted="${full_units[*]}"
else
	log "no unit runs code that changed; nothing restarted"
fi

# ------------------------------------------------------------------- summary

smoke_ok=1
smoke || smoke_ok=0

echo
echo "deploy: ================ summary ================"
echo "deploy: commit:    ${old:0:7} -> ${new:0:7}"
echo "deploy: restarted: $restarted"
echo "deploy: smoke:     $SMOKE_RESULT"
echo "deploy: backup:    $backup_path"
if [ "$DRY_RUN" = 1 ]; then
	echo "deploy: DRY RUN, $REFUSALS precondition refusal(s)"
	# Non-zero so a dry run works as a preflight check.
	[ "$REFUSALS" = 0 ] || exit 3
fi
if [ "$smoke_ok" = 0 ]; then
	cat >&2 <<EOF
deploy: smoke checks FAILED. Inspect: journalctl -u $UNIT_PREFIX-api -u $UNIT_PREFIX-web -u $UNIT_PREFIX-mcp -n 100
deploy: roll back code: cd $ROOT && git reset --hard ${old:0:7} && npm ci && npm run build && sudo systemctl restart $UNIT_PREFIX-api $UNIT_PREFIX-web $UNIT_PREFIX-mcp
deploy: the database is untouched by this script; backup taken before the deploy: $backup_path
EOF
	exit 1
fi
