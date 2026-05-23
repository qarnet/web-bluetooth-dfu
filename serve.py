#!/usr/bin/env python3
"""Serve the web-smp-dfu app over HTTPS for Web Bluetooth testing.

Usage:
    ./serve.py              # https://localhost:8443
    ./serve.py 0.0.0.0      # accessible from other devices on the LAN

First run generates a self-signed cert in .localhost.pem / .localhost-key.pem.
Accept the browser security warning once — Web Bluetooth will work thereafter.
"""

import os
import sys
import ssl
from http.server import HTTPServer, SimpleHTTPRequestHandler

CERT_FILE = ".localhost.pem"
KEY_FILE = ".localhost-key.pem"
PORT = 8443


def ensure_cert():
    if os.path.exists(CERT_FILE) and os.path.exists(KEY_FILE):
        return
    print("Generating self-signed certificate for localhost...")
    os.system(
        f'openssl req -x509 -newkey rsa:2048 -keyout {KEY_FILE} -out {CERT_FILE} '
        f'-days 365 -nodes -subj "/CN=localhost" '
        f'-addext "subjectAltName=DNS:localhost,IP:127.0.0.1"'
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
    ensure_cert()
    host = sys.argv[1] if len(sys.argv) > 1 else "localhost"
    addr = (host, PORT)

    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(CERT_FILE, KEY_FILE)

    httpd = HTTPServer(addr, Handler)
    httpd.socket = context.wrap_socket(httpd.socket, server_side=True)

    print(f"Serving HTTPS on https://{host}:{PORT}")
    print("Open that URL in Chrome, accept the cert warning, then use Web Bluetooth.")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down.")


if __name__ == "__main__":
    main()
