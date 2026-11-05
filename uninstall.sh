#!/bin/sh
# Remove VPN Selector. Your WireGuard interfaces and firewall zones are left
# as they are; delete those in LuCI (Network -> Interfaces / Firewall) if you
# no longer want them.
sed -i '/vpn-failover.sh/d' /etc/crontabs/root 2>/dev/null; /etc/init.d/cron restart
nft -a list chain inet fw4 forward_lan 2>/dev/null |
  sed -n 's/.*comment "vpn-portal".*# handle \([0-9]*\)$/\1/p' |
  while read h; do nft delete rule inet fw4 forward_lan handle "$h"; done
if [ -f /usr/bin/vpn-failover.sh.orig ]; then
  mv /usr/bin/vpn-failover.sh.orig /usr/bin/vpn-failover.sh
  echo "Restored your previous /usr/bin/vpn-failover.sh (not re-added to cron)."
else
  rm -f /usr/bin/vpn-failover.sh
fi
rm -f /usr/bin/vpn-portal-login /etc/config/vpnregions \
      /www/luci-static/resources/view/vpnregions.js \
      /usr/share/luci/menu.d/luci-app-vpnregions.json \
      /usr/share/rpcd/acl.d/luci-app-vpnregions.json \
      /tmp/vpn-failover /tmp/vpn-portal /tmp/resolv.conf.vpnregions
rm -rf /root/portal-captures
for f in /usr/bin/vpn-failover.sh /usr/bin/vpn-portal-login /www/luci-static/resources/view/vpnregions.js \
         /usr/share/luci/menu.d/luci-app-vpnregions.json /usr/share/rpcd/acl.d/luci-app-vpnregions.json /root/portal-captures/; do
  grep -vxF "$f" /etc/sysupgrade.conf > /tmp/sysupgrade.conf.$$ && cat /tmp/sysupgrade.conf.$$ > /etc/sysupgrade.conf
  rm -f /tmp/sysupgrade.conf.$$
done
uci -q delete dhcp.@dnsmasq[0].resolvfile && uci commit dhcp && /etc/init.d/dnsmasq restart
rm -rf /tmp/luci-indexcache* /tmp/luci-modulecache; /etc/init.d/rpcd reload
echo "VPN Selector removed. The kill switch (no LAN -> WAN forwarding) is unchanged;"
echo "add a lan -> wan forwarding in Network -> Firewall if you want plain internet back."
