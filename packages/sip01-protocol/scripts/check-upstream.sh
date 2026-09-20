#!/usr/bin/env bash
# check-upstream.sh — byte-diff the vendored SIP-01 protocol files against
# the pinned sip-01-core upstream commit (blueprint §5/A3). Fails on drift.
#
# Scope (vendored from src/protocol/ in sip-01-core):
#   src/webIndex.ts            — byte-verbatim EXCEPT the documented
#                                published>0 clamp (scripts/upstream-divergence.patch)
#   src/webIndex.test.ts       — byte-verbatim
#   src/indexerIdentity.ts     — byte-verbatim
#   src/indexerIdentity.test.ts — byte-verbatim
# (src/relayDiscovery.ts is a logic-verbatim PORT with an inlined dependency
# block — it is covered by unit tests, not this byte-diff.)
#
# Usage:
#   pnpm check:upstream                 # check against the pinned ref
#   SIP01_CORE_REF=<sha|tag> pnpm check:upstream   # check against another ref
#   SKIP_CHECK_UPSTREAM=1 pnpm check:upstream      # skip (offline CI etc.)
#
# Offline behavior: if GitHub is unreachable the script SKIPS with a warning
# (exit 0) — drift detection requires the upstream bytes, and a red CI from a
# sandboxed network is worse than a skipped check. Set CHECK_UPSTREAM_STRICT=1
# to turn network failure into a hard failure.

set -euo pipefail

REPO="NostrDanish/sip-01-core"
# Pinned upstream ref (software v0.1.0, cloned 2026-09-20). Override with
# SIP01_CORE_REF when deliberately re-vendoring a newer upstream.
PINNED_REF="${SIP01_CORE_REF:-v0.1.0}"

PKG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PATCH_FILE="$PKG_DIR/scripts/upstream-divergence.patch"

if [ "${SKIP_CHECK_UPSTREAM:-0}" = "1" ]; then
  echo "check-upstream: SKIP_CHECK_UPSTREAM=1 — skipped."
  exit 0
fi

skip() { echo "check-upstream: SKIP — $1"; exit 0; }

command -v curl >/dev/null || skip "curl not available"
command -v patch >/dev/null || skip "patch(1) not available"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fetch() { # $1 = upstream path, $2 = output file
  curl -fsSL --max-time 30 \
    "https://raw.githubusercontent.com/$REPO/$PINNED_REF/$1" -o "$2"
}

echo "check-upstream: diffing vendored protocol against $REPO@$PINNED_REF"

NETWORK_OK=1
for spec in \
  "src/protocol/webIndex.ts:webIndex.ts" \
  "src/protocol/webIndex.test.ts:webIndex.test.ts" \
  "src/protocol/indexerIdentity.ts:indexerIdentity.ts" \
  "src/protocol/indexerIdentity.test.ts:indexerIdentity.test.ts"; do
  upstream_path="${spec%%:*}"
  local_name="${spec##*:}"
  if ! fetch "$upstream_path" "$TMP/$local_name"; then
    if [ "${CHECK_UPSTREAM_STRICT:-0}" = "1" ]; then
      echo "check-upstream: FAIL — could not fetch $upstream_path@$PINNED_REF" >&2
      exit 1
    fi
    echo "check-upstream: WARNING — cannot reach GitHub ($upstream_path@$PINNED_REF); skipping."
    NETWORK_OK=0
    break
  fi
done
[ "$NETWORK_OK" = "1" ] || exit 0

FAILED=0
for local_name in webIndex.test.ts indexerIdentity.ts indexerIdentity.test.ts; do
  if ! cmp -s "$TMP/$local_name" "$PKG_DIR/src/$local_name"; then
    echo "check-upstream: DRIFT in src/$local_name (expected byte-verbatim):" >&2
    diff -u "$TMP/$local_name" "$PKG_DIR/src/$local_name" | head -60 >&2 || true
    FAILED=1
  fi
done

# webIndex.ts: byte-verbatim OR upstream + the one documented divergence patch.
if ! cmp -s "$TMP/webIndex.ts" "$PKG_DIR/src/webIndex.ts"; then
  cp "$TMP/webIndex.ts" "$TMP/webIndex.patched.ts"
  if patch -s "$TMP/webIndex.patched.ts" < "$PATCH_FILE" \
     && cmp -s "$TMP/webIndex.patched.ts" "$PKG_DIR/src/webIndex.ts"; then
    echo "check-upstream: webIndex.ts matches upstream + documented divergence (published>0 clamp)."
  else
    echo "check-upstream: DRIFT in src/webIndex.ts beyond the documented divergence:" >&2
    diff -u "$TMP/webIndex.ts" "$PKG_DIR/src/webIndex.ts" | head -80 >&2 || true
    FAILED=1
  fi
fi

if [ "$FAILED" = "1" ]; then
  echo "check-upstream: FAIL — vendored protocol has drifted from $REPO@$PINNED_REF." >&2
  echo "  If the drift is deliberate, re-vendor (update files + regenerate" >&2
  echo "  scripts/upstream-divergence.patch) and document it in the package README." >&2
  exit 1
fi
echo "check-upstream: OK — vendored protocol matches upstream pin ($PINNED_REF)."
