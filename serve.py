#!/usr/bin/env python3
"""Serve the web-smp-dfu app over HTTPS for Web Bluetooth testing.

Usage:
    ./serve.py                    # https://localhost:8443
    ./serve.py 0.0.0.0            # bind all interfaces (WSL → Windows proxy needed)
    ./serve.py 192.168.178.65      # bind specific LAN IP (direct LAN access)

First run generates a self-signed cert in .localhost.pem / .localhost-key.pem.
Accept the browser security warning once — Web Bluetooth will work thereafter.
"""

import os
import sys
import ssl
import socket
from http.server import HTTPServer, SimpleHTTPRequestHandler

CERT_FILE = ".localhost.pem"
KEY_FILE = ".localhost-key.pem"
PORT = 8443


def get_lan_ip():
    """Return the primary LAN IP, or None if unavailable."""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.settimeout(0.5)
        # Does not need to be reachable; just triggers routing table lookup
        s.connect(("192.168.178.1", 1))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return None


def ensure_cert(include_ip=None):
    if os.path.exists(CERT_FILE) and os.path.exists(KEY_FILE):
        # If we need a LAN IP and the cert might not have it, force regen.
        # We simply delete and recreate to keep logic simple.
        if include_ip:
            os.remove(CERT_FILE)
            os.remove(KEY_FILE)
        else:
            return

    san = "DNS:localhost,IP:127.0.0.1"
    if include_ip:
        san += f",IP:{include_ip}"

    print(f"Generating self-signed certificate ({'with LAN IP ' + include_ip if include_ip else 'localhost only'})...")
    os.system(
        f'openssl req -x509 -newkey rsa:2048 -keyout {KEY_FILE} -out {CERT_FILE} '
        f'-days 365 -nodes -subj "/CN=localhost" '
        f'-addext "subjectAltName={san}"'
    )
    print(f"Certificate created: {CERT_FILE}")


class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        # Required for ES modules on localhost (MIME type)
        if self.path.endswith(".js"):
            self.send_header("Content-Type", "application/javascript")
        elif self.path.endswith(".mjs"):
            self.send_header("Content-Type", "application/javascript")
        super().end_headers()

    def log_message(self, fmt, *args):
        # Suppress routine request noise
        pass


def main():
    host = sys.argv[1] if len(sys.argv) > 1 else "localhost"
    addr = (host, PORT)

    # Determine if we need LAN IP in the cert.
    # If host is 0.0.0.0 or a non-loopback IP, include it in the SAN.
    lan_ip = None
    if host == "0.0.0.0":
        lan_ip = get_lan_ip()
    elif host not in ("localhost", "127.0.0.1"):
        lan_ip = host

    ensure_cert(include_ip=lan_ip)

    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(CERT_FILE, KEY_FILE)

    httpd = HTTPServer(addr, Handler)
    httpd.socket = context.wrap_socket(httpd.socket, server_side=True)

    print(f"Serving HTTPS on https://{host}:{PORT}")
    if lan_ip:
        print(f"Also reachable from LAN at https://{lan_ip}:{PORT}")
    print("Open that URL in Chrome, accept the cert warning, then use Web Bluetooth.")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down.")


if __name__ == "__main__":
    main()
