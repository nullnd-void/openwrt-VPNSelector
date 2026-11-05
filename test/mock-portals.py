import http.server, threading, urllib.parse as up, sys
class S(http.server.BaseHTTPRequestHandler):
    def log_message(self,*a): pass
    def send(self,code=200,body='',hdr=None):
        self.send_response(code)
        for k,v in (hdr or {}).items(): self.send_header(k,v)
        self.send_header('Content-Type','text/html'); b=body.encode(); self.send_header('Content-Length',str(len(b))); self.end_headers(); self.wfile.write(b)
    def q(self): return up.parse_qs(up.urlsplit(self.path).query)
    def form(self):
        n=int(self.headers.get('Content-Length') or 0); return up.parse_qs(self.rfile.read(n).decode())
    def p(self): return up.urlsplit(self.path).path
    def base(self): return 'http://127.0.0.1:%d'%self.server.server_port
    def do_GET(self): self.route('GET')
    def do_POST(self): self.route('POST')
    def route(self,m):
        sc=self.server.sc; st=self.server.st; path=self.p()
        if path=='/success.txt':
            return self.send(200,'success\n') if st.get('ok') else self.send(302,'',{'Location':self.base()+sc['start']})
        sc['h'](self,m,path,st)
def accept(s,m,p,st):
    if p=='/portal': return s.send(200,'<html><form method="post" action="/login"><input type="hidden" name="tok" value="abc&amp;1"><label><input type="checkbox" name="accept_terms" required> I accept</label><input type="checkbox" name="newsletter" value="yes"><input type="submit" name="go" value="Connect"></form></html>',{'Set-Cookie':'sid=42'})
    if p=='/login' and m=='POST':
        f=s.form(); ok=f.get('tok')==['abc&1'] and f.get('accept_terms')==['on'] and 'newsletter' not in f and 'sid=42' in (s.headers.get('Cookie') or '')
        st['ok']=ok; st['got']=f; return s.send(302,'',{'Location':'/welcome'})
    s.send(200,'welcome')
def room(s,m,p,st):
    if p=='/start': return s.send(200,'<meta http-equiv="refresh" content="0; URL=/guest/login.html?x=1">')
    if p=='/guest/login.html': return s.send(200,'''<form action='auth.cgi' method=POST><select name="lang"><option value="de">de<option value="en" selected>en</select>
      <input name="lastName" placeholder="Surname" required><input type="text" id="roomNumber" name="rn" required>
      <input type="checkbox" name="agree" value="1"><input type="hidden" name="mac" value="aa:bb"><button type="submit">Log in</button></form><form action="/search"><input name="q"></form>''')
    if p=='/guest/auth.cgi':
        f=s.form(); st['got']=f; st['ok']= f.get('lastName')==['Smith'] and f.get('rn')==['412'] and f.get('agree')==['1'] and f.get('lang')==['en']
        return s.send(200,'done')
    s.send(404,'')
def meraki(s,m,p,st):
    if p=='/start': return s.send(302,'',{'Location':'/splash?base_grant_url=%s&user_continue_url=http%%3A%%2F%%2Fexample.com&node_mac=x'%up.quote(s.base()+'/grant',safe='')})
    if p=='/splash': return s.send(200,'<div id=app></div><script src=app.js></script>')
    if p=='/grant': st['ok']=s.q().get('continue_url')==['http://example.com']; return s.send(302,'',{'Location':'http://example.com/'})
def wlc(s,m,p,st):
    if p=='/start': return s.send(302,'',{'Location':'/fs/customwebauth/login.html?switch_url=%s&redirect=example.com/'%up.quote(s.base()+'/login.html',safe='')})
    if p.endswith('login.html') and m=='POST': f=s.form(); st['ok']=f.get('buttonClicked')==['4']; return s.send(200,'ok')
    s.send(200,'<script>doLogin()</script>')
def jsonly(s,m,p,st): s.send(200,'<html><body><div id="root"></div><script src="/static/app.js"></script></body></html>')
def voucher(s,m,p,st): s.send(200,'<form method=post action=/v><input name="voucher_code" required><input type=submit></form>')
def mikrotik(s,m,p,st):
    if p=='/start': return s.send(302,'',{'Location':'/login?dst=http%3A%2F%2Fexample.com'})
    if p=='/login' and 'username' in s.q(): st['ok']=s.q()['username'][0].startswith('T-'); return s.send(200,'You are logged in')
    if p=='/login': return s.send(200,'<form name=login action="/login" method=post><input name=username><input type=password name=password></form><a href="/login?dst=http%3A%2F%2Fexample.com&amp;username=T-AA%3ABB">Free trial</a>')
def opn(s,m,p,st):
    if p=='/index.html': return s.send(200,'<script src="/js/captiveportal.js"></script><div id="login"></div>')
    if p=='/api/captiveportal/access/logon/1' and m=='POST': st['ok']=True; return s.send(200,'{"clientState":"AUTHORIZED"}')
    s.send(404,'')
SC={8701:dict(h=accept,start='/portal'),8702:dict(h=room,start='/start'),8703:dict(h=meraki,start='/start'),8704:dict(h=wlc,start='/start'),
    8705:dict(h=jsonly,start='/'),8706:dict(h=voucher,start='/'),8707:dict(h=mikrotik,start='/start'),8001:dict(h=opn,start='/index.html?redirurl=x')}
for port,sc in SC.items():
    srv=http.server.ThreadingHTTPServer(('127.0.0.1',port),S); srv.sc=sc; srv.st={}
    threading.Thread(target=srv.serve_forever,daemon=True).start()
import time
while True: time.sleep(60)
