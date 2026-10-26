"""Serve the simulation to the local network (Wi-Fi / LAN).

usage: python serve-lan.py [--port 8046] [--https-port 8446] [--no-https]

HTTP on --port for every device on the network. Browsers only enable WebGPU on localhost or HTTPS, so a phone or another
computer opening the HTTP address falls back to the slower WebGL 2; the HTTPS port (a self-signed certificate made with
openssl on first run, kept in .cert/) gets WebGPU after the browser's one-time "not private / proceed anyway" warning.
"""
import argparse
import http.server
import mimetypes
import os
import shutil
import socket
import ssl
import subprocess
import sys
import threading

ROOT = os.path.dirname(os.path.abspath(__file__))
CERT_DIR = os.path.join(ROOT, '.cert')

# Windows can map .js to text/plain in the registry, which browsers refuse for module scripts
for ext, kind in {'.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.css': 'text/css',
                  '.wasm': 'application/wasm', '.svg': 'image/svg+xml'}.items():
    mimetypes.add_type(kind, ext)


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, '.js': 'text/javascript', '.mjs': 'text/javascript'}

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        # always fetch fresh files after a rebuild of the city data
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()

    def log_message(self, fmt, *args):
        if args and str(args[1]).startswith(('4', '5')):  # only failed requests
            super().log_message(fmt, *args)


def lan_addresses():
    """This computer's IPv4 addresses on the local network (the default route's first)."""
    found = []
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(('10.255.255.255', 1))  # no packet is sent: only picks the outgoing interface
            found.append(s.getsockname()[0])
    except OSError:
        pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            found.append(info[4][0])
    except OSError:
        pass
    return [a for a in dict.fromkeys(found) if not a.startswith('127.')]


def ensure_certificate(addresses):
    """A self-signed certificate for localhost & the LAN addresses (made again when an address is new), or None."""
    key = os.path.join(CERT_DIR, 'key.pem')
    cert = os.path.join(CERT_DIR, 'cert.pem')
    names = os.path.join(CERT_DIR, 'names.txt')
    wanted = ','.join(['DNS:localhost', 'IP:127.0.0.1'] + [f'IP:{a}' for a in addresses])
    if os.path.exists(cert) and os.path.exists(names) and open(names).read() == wanted:
        return cert, key
    openssl = shutil.which('openssl') or next((p for p in (r'C:\Program Files\Git\usr\bin\openssl.exe',
                                                            r'C:\Program Files\Git\mingw64\bin\openssl.exe') if os.path.exists(p)), None)
    if not openssl:
        print('  (openssl not found: HTTPS off. Install Git for Windows, or open the HTTP address.)')
        return None
    os.makedirs(CERT_DIR, exist_ok=True)
    r = subprocess.run([openssl, 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '825',
                        '-keyout', key, '-out', cert, '-subj', '/CN=Slop Kahramanmaras (LAN)', '-addext', f'subjectAltName={wanted}'],
                       capture_output=True, text=True)
    if r.returncode != 0:
        print(f'  (openssl failed, HTTPS off: {r.stderr.strip()[:200]})')
        return None
    with open(names, 'w') as f:
        f.write(wanted)
    return cert, key


def serve(port, context=None):
    httpd = http.server.ThreadingHTTPServer(('0.0.0.0', port), Handler)
    if context:
        httpd.socket = context.wrap_socket(httpd.socket, server_side=True)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


def main():
    p = argparse.ArgumentParser(description='Serve the simulation to the local network.')
    p.add_argument('--port', type=int, default=8046)
    p.add_argument('--https-port', type=int, default=8446)
    p.add_argument('--no-https', action='store_true')
    a = p.parse_args()

    addresses = lan_addresses()
    try:
        serve(a.port)
    except OSError as e:
        sys.exit(f'Port {a.port} is busy ({e}). Try: python serve-lan.py --port 8047')
    https = None
    if not a.no_https:
        pair = ensure_certificate(addresses)
        if pair:
            ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            ctx.load_cert_chain(*pair)
            try:
                serve(a.https_port, ctx)
                https = a.https_port
            except OSError as e:
                print(f'  (HTTPS port {a.https_port} is busy, HTTPS off: {e})')

    print('\nSlop Kahramanmaras is on the network. Open on any device on the same Wi-Fi:\n')
    for ip in addresses or ['<this computer\'s IP>']:
        if https:
            print(f'  https://{ip}:{https}/   (WebGPU, fast; accept the certificate warning once)')
        print(f'  http://{ip}:{a.port}/    (WebGL 2, slower)')
    print(f'\n  On this computer: http://localhost:{a.port}/')
    print('\nIf other devices cannot connect, allow Python through Windows Firewall on "Private" networks.')
    print('Press Ctrl+C to stop.\n')
    try:
        threading.Event().wait()
    except KeyboardInterrupt:
        print('stopped')


if __name__ == '__main__':
    main()
