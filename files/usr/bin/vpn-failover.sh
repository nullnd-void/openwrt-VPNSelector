#!/bin/sh
# vpn-failover: keep exactly one WireGuard tunnel up and move to the next
# one in the list when it stops working. Run from cron once a minute.
#
# The tunnels, their regions and the active region live in
# /etc/config/vpnregions and are edited in LuCI under Services -> VPN Regions.
#
#   vpn-failover.sh               normal check (what cron runs)
#   vpn-failover.sh next          switch to the next tunnel in the region now
#   vpn-failover.sh portal [min]  hotel login: let the LAN out over the plain
#                                 uplink for a few minutes, VPN kept down
#   vpn-failover.sh portal close  end the hotel login window early
#
# Travelmate looks after the Wi-Fi uplink; this script owns the VPN. Keep
# travelmate's own VPN option off (trm_vpn=0) or the two fight.

export PATH=/usr/sbin:/usr/bin:/sbin:/bin
. /lib/functions.sh

STATE="/tmp/vpn-failover"
LOCK="/tmp/vpn-failover.lock"
PORTAL="/tmp/vpn-portal"   # holds the time the hotel login window closes
TRM_RT="/var/run/travelmate/travelmate.runtime.json"
DNSFILE="/tmp/resolv.conf.vpnregions"            # dnsmasq's resolvfile
DNSAUTO="/tmp/resolv.conf.d/resolv.conf.auto"    # every interface's DNS

log() { logger -t vpn-failover "$*"; }

# Only one copy at a time (cron and the LuCI buttons can overlap), so wait
# for a running copy to finish. A lock left behind by a killed run is
# cleared after 5 minutes.
n=0
until mkdir "$LOCK" 2>/dev/null; do
  if [ $(($(date +%s) - $(date -r "$LOCK" +%s 2>/dev/null || date +%s))) -gt 300 ]; then
    rm -rf "$LOCK"
  else
    n=$((n + 1)); [ "$n" -gt 30 ] && exit 0; sleep 1
  fi
done
trap 'rmdir "$LOCK" 2>/dev/null' EXIT

config_load vpnregions
config_get_bool ENABLED main enabled 1
config_get REGION main region all
config_get UPLINK main uplink wwan
config_get GRACE main grace 60     # seconds a freshly started tunnel gets to handshake
config_get MAXAGE main maxage 180  # a handshake older than this counts as dead
config_get PORTALMIN main portal_minutes 5
config_get_bool PORTALAUTO main portal_auto 1

ALL=""   # every tunnel this script manages
VPNS=""  # the enabled tunnels in the chosen region, in order of preference
add_tunnel() {
  local iface region enabled
  config_get iface "$1" iface
  config_get region "$1" region
  config_get_bool enabled "$1" enabled 1
  [ -n "$iface" ] || return 0
  ALL="$ALL $iface"
  [ "$enabled" = 1 ] || return 0
  [ "$REGION" = all ] || [ "$region" = "$REGION" ] || return 0
  VPNS="$VPNS $iface"
}
config_foreach add_tunnel tunnel

is_up() { [ "$(ifstatus "$1" 2>/dev/null | jsonfilter -e '@.up')" = "true" ]; }
in_list() { case " $2 " in *" $1 "*) return 0;; esac; return 1; }
# DNS: while a tunnel is up dnsmasq only asks that tunnel's DNS servers, so
# the hotel never sees which names are looked up. With no tunnel (starting
# up, or a hotel login) it uses the uplink's DNS so portals and the
# router's own checks still resolve.
set_dns() {
  local want=""
  [ -n "$1" ] && want="$(ifstatus "$1" 2>/dev/null | jsonfilter -e '@["dns-server"][*]' | sed 's/^/nameserver /')"
  [ -n "$want" ] || want="$(grep -v '^#' "$DNSAUTO" 2>/dev/null)"
  [ "$want" = "$(cat "$DNSFILE" 2>/dev/null)" ] || echo "$want" > "$DNSFILE"
}
all_down() {
  for v in $ALL; do is_up "$v" && ifdown "$v"; done
  rm -f "$STATE"
  set_dns
}

# Hotel login window: one runtime firewall rule lets the LAN forward to the
# uplink, which the kill switch otherwise forbids. It is not saved anywhere,
# so a firewall reload or reboot drops it; the window re-adds it while open.
portal_rules() {
  nft -a list chain inet fw4 forward_lan 2>/dev/null |
    sed -n 's/.*comment "vpn-portal".*# handle \([0-9]*\)$/\1/p'
}
# The rule carries its own end time ($2) where the kernel supports it, so the
# kill switch comes back even if cron never runs this script again.
portal_open_rule() {
  [ -n "$1" ] && [ -z "$(portal_rules)" ] || return 0
  nft insert rule inet fw4 forward_lan oifname "\"$1\"" meta time \< "${2:-0}" counter accept comment '"vpn-portal"' 2>/dev/null ||
    nft insert rule inet fw4 forward_lan oifname "\"$1\"" counter accept comment '"vpn-portal"'
}
portal_drop_rules() {
  for h in $(portal_rules); do nft delete rule inet fw4 forward_lan handle "$h"; done
}
# Closing also forgets every tracked connection: the firewall keeps passing
# connections it has already accepted, so anything a LAN device opened over
# the plain uplink during the window would otherwise carry on after it.
portal_close() {
  portal_drop_rules
  if [ -f "$PORTAL" ]; then
    conntrack -F >/dev/null 2>&1 || { echo f > /proc/net/nf_conntrack; } 2>/dev/null
    log "hotel login window closed"
  fi
  rm -f "$PORTAL"
}

# Travelmate's last check of the uplink found a captive portal, and a fresh
# check agrees (its status can lag behind a login that just went through).
trm_portal() {
  [ "$(uci -q get travelmate.global.trm_enabled)" = 1 ] || return 1
  case "$(jsonfilter -i "$TRM_RT" -e '@.data.travelmate_status' 2>/dev/null)" in
    *"net cp"*) ;;
    *) return 1 ;;
  esac
  [ "$(curl -s -m 8 --interface "$dev" http://detectportal.firefox.com/success.txt 2>/dev/null | tr -d ' \r\n')" != success ]
}

# Try the automatic hotel login, at most every 5 minutes per access point.
portal_autologin() {
  [ "$PORTALAUTO" = 1 ] && [ -x /usr/bin/vpn-portal-login ] || return 1
  local ap last t
  ap="$(iwinfo "$dev" info 2>/dev/null | sed -n 's/.*Access Point: \([0-9A-Fa-f:]*\).*/\1/p')"
  [ -f /tmp/vpn-portal-login.last ] && read last t < /tmp/vpn-portal-login.last
  [ "$last" = "$ap" ] && [ $((now - ${t:-0})) -lt 300 ] && return 1
  echo "$ap $now" > /tmp/vpn-portal-login.last
  log "login page on the uplink, trying automatic login"
  /usr/bin/vpn-portal-login
}

now=$(date +%s)
dev="$(ifstatus "$UPLINK" 2>/dev/null | jsonfilter -e '@.l3_device')"

case "$1" in
  portal)
    if [ "$2" = close ]; then
      portal_close
    else
      min=${2:-$PORTALMIN}
      case "$min" in ''|*[!0-9]*) min=5 ;; esac
      ends=$((now + min * 60))
      echo "$ends" > "$PORTAL"
      log "hotel login window open for $min min"
      all_down
      portal_drop_rules   # a rule from an earlier window has the old end time
      portal_open_rule "$dev" "$ends"
    fi
    exit 0
    ;;
esac

# 0. While the hotel login window is open keep the VPN down, so the login
#    page goes out over the plain uplink. Close it once the time is up.
if [ -f "$PORTAL" ]; then
  read ends < "$PORTAL"
  if [ "$now" -lt "${ends:-0}" ]; then
    all_down
    portal_open_rule "$dev" "$ends"
    exit 0
  fi
  portal_close
fi

# Failover off: leave the tunnels alone, but keep DNS on a tunnel that the
# user started by hand.
if [ "$ENABLED" != 1 ]; then
  up=""
  for v in $ALL; do is_up "$v" && { up=$v; break; }; done
  set_dns "$up"
  exit 0
fi

# 1. The uplink must reach the internet on its own first. Until it does
#    (no Wi-Fi yet, or a captive portal still waiting for a login) keep
#    every tunnel down so the portal page can load. Some portals let ping
#    through, so also trust travelmate when it has seen a portal.
# Ping first; some hotels block ICMP, so fall back to an HTTP check that a
# portal can't fake (it must answer 204 with an empty body).
uplink_online() {
  ping -c 2 -W 3 -I "$dev" 1.1.1.1 >/dev/null 2>&1 && return 0
  [ "$(curl -s -o /dev/null -w '%{http_code}' --interface "$dev" -m 8 \
        http://connectivitycheck.gstatic.com/generate_204 2>/dev/null)" = 204 ]
}
if ! is_up "$UPLINK"; then
  [ -f "$STATE" ] && log "uplink is down, stopping VPN"
  all_down
  exit 0
fi
if ! uplink_online || trm_portal; then
  [ -f "$STATE" ] && log "uplink has no internet or shows a login page, stopping VPN"
  all_down
  # the login runs from the router; the LAN stays blocked meanwhile
  portal_autologin && uplink_online || exit 0
fi

if [ -z "$VPNS" ]; then
  [ -f "$STATE" ] && log "no enabled tunnels in region '$REGION', stopping VPN"
  all_down
  exit 0
fi

cur=""; since=0
[ -f "$STATE" ] && read cur since < "$STATE"

# Adopt a tunnel that was started by hand, at boot or by netifd, and record
# it so it gets the usual grace period and logging.
if [ -z "$cur" ]; then
  for v in $VPNS; do
    is_up "$v" && { cur=$v; since=$now; echo "$cur $now" > "$STATE"; log "adopting $cur"; break; }
  done
fi

# The region was changed, or the tunnel was disabled or deleted: drop it
# and start the first tunnel of the region.
if [ -n "$cur" ] && ! in_list "$cur" "$VPNS"; then
  log "$cur is not in region '$REGION' any more"
  is_up "$cur" && ifdown "$cur"
  cur=""
fi

healthy() {
  is_up "$1" || return 1
  hs=$(wg show "$1" latest-handshakes 2>/dev/null | awk '$2>m{m=$2} END{print m+0}')
  [ "$hs" -gt 0 ] && [ $((now - hs)) -lt "$MAXAGE" ] || return 1
  ping -c 2 -W 3 -I "$1" 1.1.1.1 >/dev/null 2>&1
}

# 2. Keep the current tunnel while it works, and make sure it is the only one up.
if [ -n "$cur" ]; then
  for v in $ALL; do [ "$v" != "$cur" ] && is_up "$v" && ifdown "$v"; done
  if [ "$1" = next ]; then
    log "switching from $cur on request"
  else
    healthy "$cur" && { set_dns "$cur"; exit 0; }
    [ $((now - since)) -lt "$GRACE" ] && exit 0
    log "$cur is not passing traffic, switching"
  fi
  ifdown "$cur"
else
  for v in $ALL; do is_up "$v" && ifdown "$v"; done
fi

# 3. Start the next tunnel in the list, wrapping round to the first.
set -- $VPNS
first=$1; next=$1
if [ -n "$cur" ]; then
  while [ $# -gt 0 ]; do
    [ "$1" = "$cur" ] && { next=${2:-$first}; break; }
    shift
  done
fi
log "starting $next (region '$REGION')"
set_dns
ifup "$next"
echo "$next $now" > "$STATE"
# Move DNS to the tunnel as soon as it has a handshake, instead of leaving
# lookups on the uplink's DNS until the next run a minute later.
i=0
while [ "$i" -lt 15 ]; do
  sleep 1; i=$((i + 1))
  hs=$(wg show "$next" latest-handshakes 2>/dev/null | awk '$2>m{m=$2} END{print m+0}')
  [ "$hs" -gt 0 ] && is_up "$next" && { set_dns "$next"; break; }
done
exit 0
