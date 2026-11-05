# openwrt-VPNSelector

Multiple WireGuard VPN selector for OpenWrt routers, made for travel routers.

It adds a LuCI page, **Services → VPN Regions**, and a failover script. The router keeps exactly one tunnel up and moves to the next one when that tunnel stops passing traffic. You group tunnels by region (Switzerland, Canada and so on) and choose which region to use from the web page.

Tested on a Cudy TR3000 with OpenWrt 25.12 (apk), travelmate 2.4.9 and Proton VPN WireGuard configs. It should work on any OpenWrt 23.05 or later with LuCI and fw4 (nftables).

## What it does

- **Add WireGuard configs.** Pick one or more `.conf` files from your provider (or paste one) and type a region name. The page creates the WireGuard interface, adds it to the `VPN` firewall zone and puts it in the failover list. Then it applies the change with LuCI's usual rollback protection.
- **Use region.** Choose one region, or All. The script only cycles through the enabled tunnels of that region, in the table's order. When you change the region, it switches tunnels within a minute.
- **Tunnels table.**
  - Drag rows to reorder them, edit the region, and tick tunnels on or off.
  - See each tunnel's server and last handshake.
  - Remove a tunnel. You can also delete its interface and keys.
- **Check now** and **Switch to next tunnel** run the script straight away.
- **Wi-Fi uplink** shows travelmate's status. If travelmate's own VPN option is on, a button turns it off.
- **Hotel Wi-Fi login.** When the uplink shows a login page, the router tries to sign in by itself while your devices stay blocked.
  - It recognises Meraki, Cisco WLC, OPNsense and MikroTik trial logins.
  - For other pages it fills in the form: it ticks the terms box and enters the surname, room number and e-mail you set on the page.
  - It retries at most every 5 minutes per access point.
- **Saved login pages.** A login page the router can't get through is saved to `/root/portal-captures`, with cookie values hidden. One page is kept per access point, up to the newest 10. You can download them from the page so a login for that hotel can be added later. See [docs/portal-research.md](docs/portal-research.md).
- **Manual login** opens the plain uplink for 5 minutes, with the VPN down, so a phone or laptop can sign in to a portal. It closes by itself, then the VPN comes back.
- **No DNS leaks.** While a tunnel is up, dnsmasq only asks that tunnel's DNS servers. The uplink's DNS is used only while no tunnel is up, for example during a hotel login.

## Install

Copy `install.sh` to the router and run it. Replace `192.168.1.1` with your router's address.

```
scp -O install.sh root@192.168.1.1:/tmp/
ssh root@192.168.1.1 sh /tmp/install.sh --killswitch
```

Or download it on the router itself:

```
wget -O /tmp/install.sh https://raw.githubusercontent.com/nullnd-void/openwrt-VPNSelector/main/install.sh
sh /tmp/install.sh --killswitch
```

The installer does the following:

- Installs `curl`, `wireguard-tools`, `kmod-wireguard` and `luci-proto-wireguard` if any are missing. It uses apk or opkg, whichever the router has.
- Creates `/etc/config/vpnregions`. Any existing WireGuard interfaces are added as tunnels, with the region taken from the name (`VPN_Canada` becomes Canada).
- Uses `wwan` (travelmate's uplink) as the uplink if it exists, otherwise `wan`. You can change this on the page.
- Creates a `VPN` firewall zone (masquerade, MSS clamping) and a LAN → VPN forwarding if they are missing.
- With `--killswitch`, removes LAN → WAN forwarding, so nothing leaves the LAN unless a tunnel is up. Without the flag the router falls back to the plain uplink when no tunnel works.
- Turns off travelmate's own VPN option (`trm_vpn`) if it is on.
- Points dnsmasq at `/tmp/resolv.conf.vpnregions`.
- Adds a cron job that runs every minute.
- Adds its files to `/etc/sysupgrade.conf`, so they survive a firmware upgrade.

Running the installer again updates the files and keeps your tunnels and settings. Then open **Services → VPN Regions**. If the menu entry is missing, log out of LuCI and back in.

## With travelmate

Travelmate owns the Wi-Fi: it scans, joins networks and detects captive portals. `vpn-failover.sh` owns the VPN.

Every minute the script checks that the uplink reaches the internet on its own. It also checks that travelmate hasn't seen a login page (status `net cp`). Until both are true, every tunnel stays down, the LAN stays blocked by the kill switch and the router tries the automatic login. Then the script starts the first working tunnel of the chosen region.

Keep travelmate's VPN option off (`trm_vpn=0`). When it is on, travelmate takes down every WireGuard interface on each reconnect, which fights the failover. The LuCI travelmate wizard can turn it back on, and the VPN Regions page shows a button to turn it off again.

## Commands

```
vpn-failover.sh               normal check (what cron runs)
vpn-failover.sh next          switch to the next tunnel in the region now
vpn-failover.sh portal [min]  open the plain uplink for a hotel login, VPN down
vpn-failover.sh portal close  end the hotel login window early
vpn-portal-login              try the automatic hotel login now
vpn-portal-login capture      save the current login page to /root/portal-captures
```

Logs go to syslog: `logread -e vpn-failover`.

## Settings (`/etc/config/vpnregions`)

| Option | Default | Meaning |
|---|---|---|
| `main.enabled` | 1 | Turn the failover on or off |
| `main.region` | all | Region to use, or `all` |
| `main.uplink` | wwan | The uplink interface the VPN runs over |
| `main.grace` | 60 | Seconds a newly started tunnel gets to handshake |
| `main.maxage` | 180 | A handshake older than this counts as dead |
| `main.portal_minutes` | 5 | Length of the manual login window |
| `main.portal_auto` | 1 | Try the automatic hotel login |
| `main.portal_surname`, `portal_room`, `portal_email` | | Filled into hotel login forms |
| `tunnel.iface` | | WireGuard interface name |
| `tunnel.region` | | Region name |
| `tunnel.enabled` | 1 | Include this tunnel in failover |

Tunnels may share the same address (Proton gives every config 10.2.0.2). That works because only one tunnel is ever up.

## Uninstall

```
ssh root@192.168.1.1 sh /tmp/uninstall.sh
```

This removes the page, the scripts, the cron job and the dnsmasq setting. It leaves your WireGuard interfaces, firewall zones and kill switch as they are.

## Repository layout

- `files/` holds the files installed on the router, at their paths there.
- `installer/head.sh` and `installer/tail.sh` are the installer steps before and after the files are written.
- `tools/build-installer.sh` rebuilds `install.sh` from those. Run it after changing anything in `files/` or `installer/`, and commit both.
- `test/mock-portals.py` runs fake captive portals on 127.0.0.1 for testing `vpn-portal-login`.
