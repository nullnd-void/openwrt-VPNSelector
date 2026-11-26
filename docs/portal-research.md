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
| ElevenOS (11os.com, guestinternet.com) | gateway page auto-submits `UI`, `MA`, `SIP`, `OS`, `RN` to `secure.11os.com/roaming/<gateway type>/`, which sends the browser to `secure.guestinternet.com/portal-system/portal/?ORG=<number>` | JavaScript app only. Login methods come from `/ElevenOS/WebApi/portal/config/<org>` and `/portal-system/portal-api/templates/<id>`; login is `POST /proxy` wrapping `/Guest/Portal/CreateUserViaFree5JSONP` (free), `CreateUserViaPms9JSONP` (surname + room), `CreateUserViaAccessCode6JSONP` or `LoginUser*JSONP`, each with the gateway's `UI`/`MA`/`SIP` and a `ServicePlanCode`. Plans: `GET /ElevenOS/WebApi/portal/plan/<org>`. Free plans (method `FREE`, price 0) are automated: `POST /proxy` with JSON `{url: "https://secure.11os.com/Guest/Portal/CreateUserViaFree5JSONP", data: {UserMac, UserIpOpt, GatewayId, LoginUser: true, MarketingContact: "<email>,<first>,<last>", ServicePlanCode, ServiceQuantity: "1", EwsKey, callback: "proxy", ...}}`, taken from the app's own request. Its reply's `LandingPageUrl` is `autologin.html?switch_url=<gateway>/login.html&username=..&password=..&dst=..`; that page POSTs every parameter but `switch_url` to `switch_url` (GET for Ubiquiti), which is what logs the device in. On a later visit 11os redirects straight to that autologin URL. Room/access-code plans are not | Medium-high (request recorded from the app with dummy values, 2026-11-22; not yet tried on a real hotspot) |
| openNDS / nodogsplash | `<gw>:2050/...` | GET `/opennds_auth/?tok=<tok>&redir=` (`/nodogsplash_auth/` for nodogsplash), token in hidden input | High ([docs](https://opennds.readthedocs.io/en/v7.0.1/customize.html)) |
| UniFi guest | `<ctrl>:8880/guest/s/default/?id=<mac>&url=` | older: POST `cmd=authenticate`; newer is JS | Low |
| Aruba / ClearPass | URL with `cmd=login&mac=&switchip=` | POST `/cgi-bin/login`: `user`, `password`, `cmd=authenticate` | Low-medium |

## Unknown portals: the generic walk

For a portal none of the rules above recognise, `vpn-portal-login` acts like a person clicking through, one step at a time, and checks the uplink after each step (at most 12 steps or 90 seconds a run). On each page it lists every way on and takes the best one it hasn't taken yet:

1. a meta refresh (strongest), then a redirect in an inline script, then a form or a link or clickable element (`onclick` with `location`, `data-href`) whose text says continue, accept, agree, connect, free, get online, log in, next (also in German, French and Spanish), then an iframe;
2. forms keep their hidden fields, tick terms boxes (by name or by their `<label>` text), pick the free radio button or select option over a paid or preselected one, press the best-labelled submit button (`Connect for free` over `Upgrade for €4.99`), and fill surname, room and e-mail from the settings. A required field it has no value for (password, voucher, phone, first name) leaves the form out;
3. when nothing on the page is left, it reads the page's own scripts (same site, first four) for `fetch`, `XMLHttpRequest.open`, `$.post`/`$.ajax` and `axios` calls to an address that looks like login/accept/connect/grant/terms. It sends those with only the keys the call names that mean terms (`true`), e-mail, surname/name or room, or that match a parameter of the page's own address (MAC, AP id and so on), as JSON when the call mentions JSON. A redirect address in the reply is followed.

Never done: filling in or submitting a form with card, CVV, expiry or IBAN fields or a payment/checkout action; following a link or pressing a button that says pay, buy, premium, upgrade or shows a price; ticking newsletter or marketing boxes; decline, cancel, log-out or social sign-in links. A run that gets nowhere is saved as a capture, as before, with every step in the trace.

Surname + room number (Marriott, Hilton, IHG style): no public documentation of field names; property-specific. Plan: a generic form parser that fills fields named like surname/last/name and room from per-stay values, ticks checkboxes, keeps hidden inputs, and submits.

Design references: travelmate's own scripts ([README](https://git.openwrt.org/feed/packages/tree/net/travelmate/files/README.md)), [captive.d](https://github.com/janisstreib/captive.d), [captive-autologin](https://github.com/Onny2/captive-autologin).

Router notes: travelmate 2.4.9 only runs a script set per uplink (`script`, `script_args`, must be in /etc/travelmate/*.login); auto-added uplinks get none, so for unknown hotels the script should be called from vpn-failover.sh when travelmate reports `net cp`. curl 8.23 is installed; no `timeout` command.
