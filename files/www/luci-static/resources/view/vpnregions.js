'use strict';
'require view';
'require form';
'require uci';
'require fs';
'require ui';

/*
 * VPN Regions: import WireGuard configs, tag them with a region and choose
 * which region /usr/bin/vpn-failover.sh cycles through.
 */

const FAILOVER = '/usr/bin/vpn-failover.sh';
const TRM_RUNTIME = '/var/run/travelmate/travelmate.runtime.json';
const PORTAL_MINUTES = '5';
const PORTAL_LOGIN = '/usr/bin/vpn-portal-login';
const CAPDIR = '/root/portal-captures';

function wgInterfaces() {
	return uci.sections('network', 'interface').filter(s => s.proto == 'wireguard').map(s => s['.name']);
}

function regions() {
	const seen = {};
	uci.sections('vpnregions', 'tunnel').forEach(s => { if (s.region) seen[s.region] = true; });
	return Object.keys(seen).sort();
}

function peersOf(iface) {
	return uci.sections('network', 'wireguard_' + iface).filter(p => p.disabled != '1');
}

function ago(secs) {
	if (secs < 120) return _('%ds ago').format(secs);
	if (secs < 7200) return _('%d min ago').format(Math.floor(secs / 60));
	return _('%d h ago').format(Math.floor(secs / 3600));
}

/* Parse a wg-quick style .conf (as downloaded from Proton and most providers). */
function parseConf(text) {
	const conf = { iface: {}, peers: [] };
	let sec = null, peer = null;

	text.split(/\r?\n/).forEach(line => {
		let m = line.match(/^\s*#\s*(.*?)\s*$/);
		if (m) {
			/* Proton puts the server name as a comment right after [Peer] */
			if (sec == 'peer' && peer.comment == null && m[1] && m[1].indexOf('=') < 0)
				peer.comment = m[1];
			return;
		}

		line = line.trim();
		if (!line) return;

		if ((m = line.match(/^\[\s*(\w+)\s*\]$/))) {
			sec = m[1].toLowerCase();
			if (sec == 'peer') conf.peers.push(peer = {});
			return;
		}

		if ((m = line.match(/^(\w+)\s*=\s*(.*)$/)) && sec)
			(sec == 'peer' ? peer : conf.iface)[m[1].toLowerCase()] = m[2].trim();
	});

	if (!conf.iface.privatekey || !conf.iface.address)
		throw new Error(_('no [Interface] PrivateKey or Address'));
	if (!conf.peers.length || !conf.peers[0].publickey || !conf.peers[0].endpoint)
		throw new Error(_('no [Peer] with PublicKey and Endpoint'));

	return conf;
}

function splitList(v) {
	return (v || '').split(/[\s,]+/).filter(x => x);
}

/* Interface names become Linux device names: 15 characters at most. */
function uniqueName(hint) {
	const taken = {};
	uci.sections('network').forEach(s => taken[s['.name'].toLowerCase()] = true);

	let base = 'wg_' + (hint || 'vpn').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
	base = base.substring(0, 15);

	let name = base;
	for (let i = 2; taken[name.toLowerCase()]; i++)
		name = base.substring(0, 15 - String(i).length - 1) + '_' + i;

	return name;
}

function isDuplicate(peer) {
	return uci.sections('network').some(s =>
		s['.type'].indexOf('wireguard_') == 0 && s.public_key == peer.publickey &&
		(s.endpoint_host + ':' + s.endpoint_port) == peer.endpoint);
}

/* Create interface + peer + firewall zone membership + failover entry. */
function addTunnel(conf, hint, region, zone) {
	const name = uniqueName(conf.peers[0].comment || hint);
	const i = conf.iface;

	uci.add('network', 'interface', name);
	uci.set('network', name, 'proto', 'wireguard');
	uci.set('network', name, 'private_key', i.privatekey);
	uci.set('network', name, 'addresses', splitList(i.address));
	if (i.dns) uci.set('network', name, 'dns', splitList(i.dns));
	if (i.mtu) uci.set('network', name, 'mtu', i.mtu);
	uci.set('network', name, 'auto', '0');     /* vpn-failover starts it */
	uci.set('network', name, 'metric', '10');  /* below the uplink's 20 */

	const p = conf.peers[0];
	const m = p.endpoint.match(/^\[?(.+?)\]?:(\d+)$/);
	const sid = uci.add('network', 'wireguard_' + name);
	uci.set('network', sid, 'description', p.comment || hint);
	uci.set('network', sid, 'public_key', p.publickey);
	if (p.presharedkey) uci.set('network', sid, 'preshared_key', p.presharedkey);
	uci.set('network', sid, 'endpoint_host', m ? m[1] : p.endpoint);
	if (m) uci.set('network', sid, 'endpoint_port', m[2]);
	uci.set('network', sid, 'allowed_ips', splitList(p.allowedips || '0.0.0.0/0, ::/0'));
	uci.set('network', sid, 'route_allowed_ips', '1');
	uci.set('network', sid, 'persistent_keepalive', p.persistentkeepalive || '25');

	const z = uci.sections('firewall', 'zone').find(s => s.name == zone);
	if (z) {
		const nets = L.toArray(z.network);
		nets.push(name);
		uci.set('firewall', z['.name'], 'network', nets);
	}

	const t = uci.add('vpnregions', 'tunnel');
	uci.set('vpnregions', t, 'iface', name);
	uci.set('vpnregions', t, 'region', region);
	uci.set('vpnregions', t, 'enabled', '1');

	return name;
}

function deleteInterface(iface) {
	uci.sections('network', 'wireguard_' + iface).forEach(p => uci.remove('network', p['.name']));
	uci.remove('network', iface);

	uci.sections('firewall', 'zone').forEach(z => {
		const nets = L.toArray(z.network);
		if (nets.indexOf(iface) >= 0)
			uci.set('firewall', z['.name'], 'network', nets.filter(n => n != iface));
	});
}

function readFile(file) {
	return new Promise((resolve, reject) => {
		const r = new FileReader();
		r.onload = () => resolve(r.result);
		r.onerror = () => reject(r.error);
		r.readAsText(file);
	});
}

return view.extend({
	load() {
		return uci.load('vpnregions').then(() => Promise.all([
			uci.load('network'),
			uci.load('firewall'),
			L.resolveDefault(fs.read('/tmp/vpn-failover'), ''),
			L.resolveDefault(fs.exec('/usr/bin/wg', [ 'show', 'all', 'latest-handshakes' ]), {}),
			L.resolveDefault(fs.read('/tmp/vpn-portal'), ''),
			L.resolveDefault(fs.read(TRM_RUNTIME).then(JSON.parse), {}),
			L.resolveDefault(uci.load('travelmate'), null),
			L.resolveDefault(fs.list(CAPDIR), [])
		]));
	},

	showImport() {
		const zones = uci.sections('firewall', 'zone').map(z => z.name).filter(n => n && n != 'lan' && n != 'wan');
		const regionInput = E('input', { 'class': 'cbi-input-text', 'list': 'vpnregions-list', 'placeholder': _('e.g. Switzerland') });
		const zoneSelect = E('select', { 'class': 'cbi-input-select' },
			zones.map(n => E('option', { 'value': n, 'selected': n == 'VPN' || null }, n)));
		const fileInput = E('input', { 'type': 'file', 'accept': '.conf,text/plain', 'multiple': true });
		const pasteArea = E('textarea', { 'class': 'cbi-input-textarea', 'rows': 8, 'style': 'width:100%;font-family:monospace',
			'placeholder': '[Interface]\nPrivateKey = ...\nAddress = 10.2.0.2/32\n\n[Peer]\nPublicKey = ...\nEndpoint = 1.2.3.4:51820' });

		const row = (label, el, hint) => E('div', { 'class': 'cbi-value' }, [
			E('label', { 'class': 'cbi-value-title' }, label),
			E('div', { 'class': 'cbi-value-field' }, [ el, hint ? E('div', { 'class': 'cbi-value-description' }, hint) : '' ])
		]);

		ui.showModal(_('Add WireGuard configs'), [
			E('datalist', { 'id': 'vpnregions-list' }, regions().map(r => E('option', { 'value': r }))),
			row(_('Region'), regionInput, _('All imported configs get this region. Use the same name to group servers of one country.')),
			row(_('Firewall zone'), zoneSelect, _('Must be a VPN zone, so the kill switch lets LAN traffic through this tunnel.')),
			row(_('Config files'), fileInput, _('Pick one or more .conf files, as downloaded from your VPN provider.')),
			row(_('Or paste a config'), pasteArea),
			E('div', { 'class': 'right' }, [
				E('button', { 'class': 'cbi-button', 'click': ui.hideModal }, _('Cancel')), ' ',
				E('button', { 'class': 'cbi-button cbi-button-positive', 'click': ui.createHandlerFn(this, () => {
					const region = regionInput.value.trim();
					if (!/^[A-Za-z0-9_-]{1,32}$/.test(region) || region == 'all') {
						ui.addNotification(null, E('p', _('Enter a region name using letters, digits, - or _ only.')), 'warning');
						return;
					}

					const sources = Array.from(fileInput.files).map(f =>
						readFile(f).then(text => ({ hint: f.name.replace(/\.conf$/i, ''), text })));
					if (pasteArea.value.trim())
						sources.push(Promise.resolve({ hint: region, text: pasteArea.value }));
					if (!sources.length) {
						ui.addNotification(null, E('p', _('Choose a file or paste a config first.')), 'warning');
						return;
					}

					return Promise.all(sources).then(items => {
						const added = [], problems = [];

						items.forEach(it => {
							try {
								const conf = parseConf(it.text);
								if (isDuplicate(conf.peers[0]))
									problems.push(_('%s: already added').format(it.hint));
								else
									added.push(addTunnel(conf, it.hint, region, zoneSelect.value));
							}
							catch (e) {
								problems.push('%s: %s'.format(it.hint, e.message));
							}
						});

						ui.hideModal();
						if (problems.length)
							ui.addNotification(_('Some configs were skipped'), E('ul', problems.map(p => E('li', [ p ]))), 'warning');
						if (!added.length)
							return;

						ui.addNotification(null, E('p', _('Added %s. Applying…').format(added.join(', '))), 'info');
						return uci.save().then(() => ui.changes.apply(true));
					});
				}) }, _('Import'))
			])
		]);
	},

	render(data) {
		const stateLine = String(data[2] || '').trim().split(/\s+/);
		const handshakes = {};
		String(data[3].stdout || '').split('\n').forEach(l => {
			const f = l.trim().split(/\s+/);
			if (f.length == 3) handshakes[f[0]] = Math.max(handshakes[f[0]] || 0, +f[2]);
		});
		const active = stateLine[0] || null;
		const now = Math.floor(Date.now() / 1000);
		const portalEnds = +String(data[4] || '').trim() || 0;
		const portalOpen = portalEnds > now;
		const trm = (data[5] && data[5].data) || {};
		const trmEnabled = uci.get('travelmate', 'global', 'trm_enabled') == '1';
		const trmStatus = trm.travelmate_status || '';
		const trmPortal = trmEnabled && /net cp/.test(trmStatus);
		const trmVpn = uci.get('travelmate', 'global', 'trm_vpn') == '1';
		const captures = (data[7] || []).filter(f => f.type == 'file' && /\.txt$/.test(f.name))
			.sort((a, b) => b.mtime - a.mtime);

		const m = new form.Map('vpnregions', _('VPN Regions'),
			_('Choose which WireGuard tunnels the failover script may use. It keeps one tunnel up and moves to the next one of the chosen region when it stops working. The kill switch stays on: if no tunnel works, nothing goes out.'));

		let s = m.section(form.NamedSection, 'main', 'settings', _('Failover'));

		let o = s.option(form.DummyValue, '_status', _('Status'));
		o.rawhtml = true;
		o.cfgvalue = () => {
			if (!active)
				return E('em', portalOpen ? _('VPN off while the hotel login window is open.')
					: _('No tunnel up (no uplink internet yet, a login page waiting, or no tunnel in this region).')).outerHTML;
			const hs = handshakes[active];
			return E('span', [
				E('strong', [ active ]), ' ',
				_('since %s').format(new Date(+stateLine[1] * 1000).toLocaleTimeString()), ', ',
				hs ? _('last handshake %s').format(ago(Math.max(0, now - hs))) : _('no handshake yet')
			]).outerHTML;
		};

		o = s.option(form.DummyValue, '_uplink', _('Wi-Fi uplink'));
		o.rawhtml = true;
		o.cfgvalue = () => {
			const parts = [];
			if (trmEnabled)
				parts.push(E('span', [ _('Travelmate: %s').format(trmStatus || _('no status yet')),
					trm.station_id ? ' (%s)'.format(trm.station_id.replace(/\/-$/, '')) : '' ]));
			else
				parts.push(E('em', _('Travelmate is off.')));
			parts.push(' ', E('a', { 'href': L.url('admin/services/travelmate') }, _('Join a Wi-Fi network…')));
			if (trmPortal)
				parts.push(E('div', { 'class': 'alert-message warning', 'style': 'margin:.5em 0 0' },
					_('This Wi-Fi has a login page. The router tries to sign in by itself; if that fails, use “Manual login” below.')));
			if (trmVpn)
				parts.push(E('div', { 'class': 'alert-message warning', 'style': 'margin:.5em 0 0' },
					_('Travelmate’s own VPN option is on. It takes down the tunnels this page starts. Use “Let VPN Regions handle the VPN” below.')));
			return E('div', parts).outerHTML;
		};

		if (trmVpn) {
			o = s.option(form.Button, '_trmvpn', ' ');
			o.inputtitle = _('Let VPN Regions handle the VPN');
			o.inputstyle = 'negative';
			o.onclick = () => {
				uci.set('travelmate', 'global', 'trm_vpn', '0');
				uci.sections('travelmate', 'uplink').forEach(u => {
					[ 'vpn', 'vpnservice', 'vpniface' ].forEach(k => uci.unset('travelmate', u['.name'], k));
				});
				return uci.save().then(() => ui.changes.apply(true));
			};
		}

		o = s.option(form.Flag, 'enabled', _('Enable failover'),
			_('When off, the script leaves the tunnels alone and you start them yourself.'));
		o.default = '1';
		o.rmempty = false;

		o = s.option(form.ListValue, 'region', _('Use region'),
			_('Only enabled tunnels of this region are used, in the order of the table below. Takes effect within a minute of Save & Apply.'));
		o.value('all', _('All regions'));
		regions().forEach(r => o.value(r));
		o.default = 'all';

		o = s.option(form.Button, '_check', _('Actions'),
			_('These act on the saved settings, so Save & Apply first.'));
		o.inputtitle = _('Check now');
		o.inputstyle = 'apply';
		o.onclick = () => fs.exec(FAILOVER).then(() => location.reload());

		o = s.option(form.Button, '_next', ' ');
		o.inputtitle = _('Switch to next tunnel');
		o.inputstyle = 'action';
		o.onclick = () => fs.exec(FAILOVER, [ 'next' ]).then(() => location.reload());

		o = s.option(form.Button, '_import', _('Add servers'),
			_('Import WireGuard .conf files from your VPN provider and give them a region.'));
		o.inputtitle = _('Add WireGuard configs');
		o.inputstyle = 'add';
		o.onclick = ui.createHandlerFn(this, 'showImport');

		o = s.option(form.Value, 'uplink', _('Uplink interface'),
			_('The Wi-Fi uplink. The VPN stays down until this reaches the internet.'));
		o.default = 'wwan';

		s = m.section(form.NamedSection, 'main', 'settings', _('Hotel Wi-Fi login'),
			_('When the Wi-Fi shows a login page, the router tries to sign in by itself while your devices stay blocked. It ticks the terms box and fills in the details below. If it can’t, it saves the page under “Saved login pages” so a login for it can be added later, and you use the manual login.'));

		o = s.option(form.Flag, 'portal_auto', _('Automatic login'));
		o.default = '1';
		o.rmempty = false;

		o = s.option(form.Value, 'portal_surname', _('Surname'), _('As on the booking. Many hotels ask for surname and room number.'));
		o.depends('portal_auto', '1');
		o = s.option(form.Value, 'portal_room', _('Room number'), _('Change this for each stay.'));
		o.depends('portal_auto', '1');
		o = s.option(form.Value, 'portal_email', _('E-mail'), _('Only used when a login page insists on one.'));
		o.datatype = 'string';
		o.depends('portal_auto', '1');

		o = s.option(form.Button, '_trylogin', _('Try now'), _('Uses the saved settings, so Save & Apply first.'));
		o.inputtitle = _('Try automatic login');
		o.inputstyle = trmPortal ? 'apply' : 'action';
		o.onclick = () => fs.exec(PORTAL_LOGIN).then(r => {
			ui.addNotification(null, E('p', r.code == 0 ? _('Online. The VPN starts within a minute.')
				: _('Automatic login didn’t get through; the page was saved below. Use the manual login instead.')), r.code == 0 ? 'info' : 'warning');
			return new Promise(res => setTimeout(res, 2500)).then(() => location.reload());
		});

		o = s.option(form.Button, '_portal', _('Manual login'), portalOpen
			? _('Open until %s: devices on your Wi-Fi can reach the login page, without the VPN. It closes by itself, then the VPN comes back.').format(new Date(portalEnds * 1000).toLocaleTimeString())
			: _('Opens the plain hotel connection for %s minutes so a phone or laptop can sign in to the hotel’s login page. The VPN is off during that time, and the kill switch comes back automatically.').format(PORTAL_MINUTES));
		o.inputtitle = portalOpen ? _('Close now') : _('Open for %s minutes').format(PORTAL_MINUTES);
		o.inputstyle = portalOpen ? 'reset' : (trmPortal ? 'apply' : 'action');
		o.onclick = () => fs.exec(FAILOVER, portalOpen ? [ 'portal', 'close' ] : [ 'portal', PORTAL_MINUTES ])
			.then(() => location.reload());

		o = s.option(form.DummyValue, '_captures', _('Saved login pages'));
		o.rawhtml = false;
		o.cfgvalue = () => '';
		o.renderWidget = () => {
			if (!captures.length)
				return E('em', _('None yet.'));
			return E('div', [
				E('ul', { 'style': 'margin:0 0 .5em 1.2em' }, captures.map(f => E('li', [
					E('a', { 'href': '#', 'click': ev => {
						ev.preventDefault();
						return fs.read(CAPDIR + '/' + f.name).then(txt => {
							const a = E('a', { 'href': URL.createObjectURL(new Blob([ txt ], { type: 'text/plain' })), 'download': f.name });
							document.body.appendChild(a); a.click(); a.remove();
						});
					} }, f.name), ' (%1024mB)'.format(f.size)
				]))),
				E('div', { 'class': 'cbi-value-description' }, _('Download one and send it over, and a login for that hotel can be added.')),
				E('button', { 'class': 'cbi-button cbi-button-remove', 'click': ui.createHandlerFn(this, () =>
					Promise.all(captures.map(f => fs.remove(CAPDIR + '/' + f.name))).then(() => location.reload())) }, _('Delete all'))
			]);
		};

		o = s.option(form.Button, '_capture', ' ', _('Save the current login page now, e.g. before you sign in by hand.'));
		o.inputtitle = _('Save this login page');
		o.inputstyle = 'action';
		o.onclick = () => fs.exec(PORTAL_LOGIN, [ 'capture' ]).then(() => location.reload());

		s = m.section(form.GridSection, 'tunnel', _('Tunnels'),
			_('Drag rows to change the order. “Add existing interface” adds a WireGuard interface you set up yourself under Network → Interfaces.'));
		s.anonymous = true;
		s.addremove = true;
		s.sortable = true;
		s.addbtntitle = _('Add existing interface');
		s.modaltitle = _('Tunnel');

		s.handleRemove = function(section_id, ev) {
			const iface = uci.get('vpnregions', section_id, 'iface');
			const done = (alsoIface) => {
				if (alsoIface && iface) deleteInterface(iface);
				ui.hideModal();
				return form.GridSection.prototype.handleRemove.call(this, section_id, ev);
			};

			return new Promise(resolve => {
				ui.showModal(_('Remove %s').format(iface || _('tunnel')), [
					E('p', _('Delete the WireGuard interface and its keys as well, or only take it out of the failover list?')),
					E('div', { 'class': 'right' }, [
						E('button', { 'class': 'cbi-button', 'click': () => { ui.hideModal(); resolve(); } }, _('Cancel')), ' ',
						E('button', { 'class': 'cbi-button', 'click': () => resolve(done(false)) }, _('Only remove from list')), ' ',
						E('button', { 'class': 'cbi-button cbi-button-negative', 'click': () => resolve(done(true)) }, _('Delete interface too'))
					])
				]);
			});
		};

		o = s.option(form.ListValue, 'iface', _('Interface'));
		wgInterfaces().forEach(n => o.value(n));
		o.rmempty = false;
		o.textvalue = function(section_id) {
			const v = this.cfgvalue(section_id);
			return v == active ? E('strong', [ v, ' ●' ]) : '%h'.format(v);
		};

		o = s.option(form.DummyValue, '_server', _('Server'));
		o.modalonly = false;
		o.textvalue = function(section_id) {
			const p = peersOf(uci.get('vpnregions', section_id, 'iface'))[0];
			if (!p) return E('em', _('no enabled peer'));
			return '%h (%h:%h)'.format(p.description || '-', p.endpoint_host || '?', p.endpoint_port || '51820');
		};

		o = s.option(form.Value, 'region', _('Region'));
		regions().forEach(r => o.value(r));
		o.validate = (section_id, v) => (/^[A-Za-z0-9_-]{1,32}$/.test(v) && v != 'all') || _('Letters, digits, - and _ only');
		o.rmempty = false;
		o.editable = true;

		o = s.option(form.DummyValue, '_handshake', _('Last handshake'));
		o.modalonly = false;
		o.textvalue = function(section_id) {
			const hs = handshakes[uci.get('vpnregions', section_id, 'iface')];
			return hs ? ago(Math.max(0, now - hs)) : '-';
		};

		o = s.option(form.Flag, 'enabled', _('Enabled'));
		o.default = '1';
		o.rmempty = false;
		o.editable = true;

		return m.render();
	}
});
