#!/bin/sh
# Run vpn-portal-login against the fake portals in mock-portals.py.
#
#   test/run-tests.sh            all cases
#   test/run-tests.sh room jsapi only these
#
# Needs python3 and curl. VPN_DEV is the interface curl sends from: "lo" on
# Linux; on other systems give 127.0.0.1 (VPN_DEV=127.0.0.1 test/run-tests.sh).
cd "$(dirname "$0")/.." || exit 1
PY="${PY:-$(command -v python3 || command -v python)}"
TMP="$(mktemp -d)"
"$PY" test/mock-portals.py & MOCK=$!
trap 'kill $MOCK 2>/dev/null; rm -rf "$TMP"' EXIT
i=0; until curl -s -o /dev/null http://127.0.0.1:8701/state || [ $i -gt 50 ]; do i=$((i + 1)); sleep 0.1; done

export VPN_TEST=1 VPN_DEV="${VPN_DEV:-lo}" VPN_SURNAME=Smith VPN_ROOM=412 VPN_EMAIL=guest@example.org
pass=0; fail=0

# case NAME PORT EXPECTED-EXIT [CHECK [LOG]]: CHECK is a grep -E pattern the
# portal's /state must match (or, starting with "!", must not match), LOG one
# the script's log must match
case_() {
  name="$1"; port="$2"; want="$3"; check="$4"; logpat="$5"
  if [ -n "$ONLY" ]; then case " $ONLY " in *" $name "*) ;; *) return ;; esac; fi
  rm -rf "$TMP/cap"; t0=$(date +%s)
  VPN_BSSID="test-$name-$$" VPN_PROBE="http://127.0.0.1:$port/success.txt" VPN_WORK="$TMP/work" VPN_CAPDIR="$TMP/cap" \
    sh files/usr/bin/vpn-portal-login > "$TMP/out" 2>&1
  got=$?; took=$(($(date +%s) - t0))
  state="$(curl -s "http://127.0.0.1:$port/state")"
  ok=1; [ "$got" = "$want" ] || ok=""
  case "$check" in
    "") ;;
    !*) echo "$state" | grep -qE "${check#!}" && ok="" ;;
    *) echo "$state" | grep -qE "$check" || ok="" ;;
  esac
  [ -n "$logpat" ] && ! grep -qE "$logpat" "$TMP/out" && ok=""
  # a failed login leaves a capture
  [ "$want" = 1 ] && ! ls "$TMP"/cap/*.txt >/dev/null 2>&1 && ok=""
  if [ -n "$ok" ]; then pass=$((pass + 1)); echo "ok   $name (${took}s)"
  else fail=$((fail + 1)); echo "FAIL $name: exit $got, want $want; state $state"; sed 's/^/     /' "$TMP/out"; fi
}

ONLY="$*"
case_ accept     8701 0
case_ room       8702 0
case_ meraki     8703 0
case_ wlc        8704 0
case_ jsonly     8705 1
case_ voucher    8706 1 '' 'needs voucher_code'
case_ mikrotik   8707 0
case_ elevenos   8708 0
curl -s -o /dev/null http://127.0.0.1:8708/reset; curl -s -o /dev/null http://127.0.0.1:8708/again
case_ elevenos-again 8708 0
case_ opnsense   8001 0
case_ multistep  8709 0 '!"(shop|paid)"'
case_ paywall    8710 1 '!"posted"' 'only offers paid access'
case_ jsapi      8711 0
case_ frame      8712 0
case_ loop       8713 1 '"n": ([0-9]|1[0-4])[,}]'
echo "$pass passed, $fail failed"
[ "$fail" = 0 ]
