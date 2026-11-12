
chmod +x /usr/bin/vpn-failover.sh /usr/bin/vpn-portal-login
mkdir -p /root/portal-captures
uci -q get vpnregions.main.portal_auto >/dev/null || { uci set vpnregions.main.portal_auto='1'; uci commit vpnregions; }

# keep the add-on and saved login pages across firmware upgrades
for f in /usr/bin/vpn-failover.sh /usr/bin/vpn-portal-login /www/luci-static/resources/view/vpnregions.js \
         /usr/share/luci/menu.d/luci-app-vpnregions.json /usr/share/rpcd/acl.d/luci-app-vpnregions.json /root/portal-captures/; do
  grep -qxF "$f" /etc/sysupgrade.conf 2>/dev/null || echo "$f" >> /etc/sysupgrade.conf
done
grep -q vpn-failover.sh /etc/crontabs/root 2>/dev/null || {
  echo '* * * * * /usr/bin/vpn-failover.sh' >> /etc/crontabs/root
  /etc/init.d/cron enable
  /etc/init.d/cron restart
}
rm -rf /tmp/luci-indexcache* /tmp/luci-modulecache
/etc/init.d/rpcd reload

# travelmate looks after Wi-Fi only; its own VPN switching fights this script
if [ "$(uci -q get travelmate.global.trm_vpn)" = 1 ]; then
  uci set travelmate.global.trm_vpn='0'
  uci commit travelmate
  /etc/init.d/travelmate restart
  echo "Turned off travelmate's own VPN option (VPN Regions handles the VPN)."
fi

# DNS: dnsmasq takes its upstream servers from a file that vpn-failover.sh
# keeps pointed at the active tunnel's DNS, so lookups don't leak to the hotel
grep -v '^#' /tmp/resolv.conf.d/resolv.conf.auto > /tmp/resolv.conf.vpnregions 2>/dev/null || true
if [ "$(uci -q get dhcp.@dnsmasq[0].resolvfile)" != /tmp/resolv.conf.vpnregions ]; then
  uci set dhcp.@dnsmasq[0].resolvfile='/tmp/resolv.conf.vpnregions'
  uci commit dhcp
  /etc/init.d/dnsmasq restart
fi
sh /usr/bin/vpn-failover.sh

echo "Installed. Tunnels found:"
uci show vpnregions | grep -E "\.(iface|region)="
echo "Open LuCI → Services → VPN Regions (log out and back in if the menu entry is missing)."
if [ -n "$(has_fwd lan wan)" ]; then
  echo "Note: LAN -> WAN forwarding is still on, so traffic falls back to the plain uplink when no tunnel is up. Run again with --killswitch to block it."
fi
