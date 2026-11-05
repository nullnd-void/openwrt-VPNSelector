#!/bin/sh
# Rebuild install.sh from installer/head.sh, every file under files/ and
# installer/tail.sh. Run from the repository root after changing any of them.
set -e
cd "$(dirname "$0")/.."
out=install.sh
{
  cat installer/head.sh
  for f in usr/bin/vpn-failover.sh usr/bin/vpn-portal-login \
           www/luci-static/resources/view/vpnregions.js \
           usr/share/luci/menu.d/luci-app-vpnregions.json \
           usr/share/rpcd/acl.d/luci-app-vpnregions.json; do
    if grep -q '^VPNREGIONS_EOF$' "files/$f"; then echo "files/$f contains the heredoc marker" >&2; exit 1; fi
    echo
    echo "cat > /$f <<'VPNREGIONS_EOF'"
    cat "files/$f"
    echo "VPNREGIONS_EOF"
  done
  cat installer/tail.sh
} > "$out.tmp"
mv "$out.tmp" "$out"
chmod +x "$out"
echo "wrote $out"
