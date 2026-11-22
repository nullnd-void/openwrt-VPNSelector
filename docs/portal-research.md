# Hotel captive portals: what a router-side login script can handle

Researched 2026-11-05. Hotel chains don't build their own portals; a few vendors do, often chosen per property (Accor ALL and IHG Connect use Nonius; Marriott approves Nomadix gateways; Hilton's vendor not found). A script has to recognise the vendor, not the chain. JavaScript-only cloud portals (Nonius, Purple, Nomadix cloud, new UniFi) generally defeat a curl script, so Hotel login stays as the fallback.

| Vendor | Redirect looks like | Click-through / terms login | Confidence |
|---|---|---|---|
| Cisco Meraki | `*.network-auth.com/...` or splash URL with `base_grant_url=` | GET `<base_grant_url>?continue_url=<user_continue_url>` (read from each redirect) | High ([docs](https://developer.cisco.com/meraki/captive-portal-api/click-through-api/)) |
| Cisco WLC / 9800 | URL with `switch_url=<ctrl>/login.html` | POST to switch_url: `buttonClicked=4&redirect_url=<orig>&err_flag=0` (+ username/password) | Medium-high |
| FortiGate | `<fgt>:1000/fgtauth?<magic>` | POST form with `magic=` plus hidden fields (generic form submit) | Medium |
| Nomadix | gateway redirects to the hotel's portal page with `UI=`, `MA=`, `SIP=` | per property, generic form parser only | Low |
| pfSense | `<fw>:8002/index.php?zone=<z>&redirurl=` | POST same URL: `auth_user=&auth_pass=&redirurl=&zone=&accept=Continue` | Medium-high |
| OPNsense | `<fw>:<8000+zone>/index.html?redirurl=` | POST `/api/captiveportal/access/logon/<zone>` with empty `user`/`password` | Medium |
| MikroTik Hotspot | `<gw>/login?dst=<orig>` | POST form action with `username`, `password`, `dst`, `popup=true` (CHAP pages hash in JS) | Medium-high |
| ElevenOS (11os.com, guestinternet.com) | gateway page auto-submits `UI`, `MA`, `SIP`, `OS`, `RN` to `secure.11os.com/roaming/<gateway type>/`, which sends the browser to `secure.guestinternet.com/portal-system/portal/?ORG=<number>` | JavaScript app only. Login methods come from `/ElevenOS/WebApi/portal/config/<org>` and `/portal-system/portal-api/templates/<id>`; login is `POST /proxy` wrapping `/Guest/Portal/CreateUserViaFree5JSONP` (free), `CreateUserViaPms9JSONP` (surname + room), `CreateUserViaAccessCode6JSONP` or `LoginUser*JSONP`, each with the gateway's `UI`/`MA`/`SIP` and a `ServicePlanCode`. Plans: `GET /ElevenOS/WebApi/portal/plan/<org>`. Free plans (method `FREE`, price 0) are automated: `POST /proxy` with JSON `{url: "https://secure.11os.com/Guest/Portal/CreateUserViaFree5JSONP", data: {UserMac, UserIpOpt, GatewayId, LoginUser: true, MarketingContact: "<email>,<first>,<last>", ServicePlanCode, ServiceQuantity: "1", EwsKey, callback: "proxy", ...}}`, taken from the app's own request. Room/access-code plans are not | Medium-high (request recorded from the app with dummy values, 2026-11-22; not yet tried on a real hotspot) |
| openNDS / nodogsplash | `<gw>:2050/...` | GET `/opennds_auth/?tok=<tok>&redir=` (`/nodogsplash_auth/` for nodogsplash), token in hidden input | High ([docs](https://opennds.readthedocs.io/en/v7.0.1/customize.html)) |
| UniFi guest | `<ctrl>:8880/guest/s/default/?id=<mac>&url=` | older: POST `cmd=authenticate`; newer is JS | Low |
| Aruba / ClearPass | URL with `cmd=login&mac=&switchip=` | POST `/cgi-bin/login`: `user`, `password`, `cmd=authenticate` | Low-medium |

Surname + room number (Marriott, Hilton, IHG style): no public documentation of field names; property-specific. Plan: a generic form parser that fills fields named like surname/last/name and room from per-stay values, ticks checkboxes, keeps hidden inputs, and submits.

Design references: travelmate's own scripts ([README](https://git.openwrt.org/feed/packages/tree/net/travelmate/files/README.md)), [captive.d](https://github.com/janisstreib/captive.d), [captive-autologin](https://github.com/Onny2/captive-autologin).

Router notes: travelmate 2.4.9 only runs a script set per uplink (`script`, `script_args`, must be in /etc/travelmate/*.login); auto-added uplinks get none, so for unknown hotels the script should be called from vpn-failover.sh when travelmate reports `net cp`. curl 8.23 is installed; no `timeout` command.
