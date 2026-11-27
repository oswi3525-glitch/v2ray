import http.server
import os

PAYLOAD = bytes((i * 31 + 7) % 256 for i in range(8 * 1024 * 1024))

class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header('Content-Type', 'application/octet-stream')
        self.send_header('Content-Length', str(len(PAYLOAD)))
        self.end_headers()
        self.wfile.write(PAYLOAD)

    def do_POST(self):
        n = int(self.headers.get('Content-Length', '0'))
        left = n
        while left > 0:
            chunk = self.rfile.read(min(left, 65536))
            if not chunk:
                break
            left -= len(chunk)
        self.send_response(200)
        self.send_header('Content-Length', '2')
        self.end_headers()
        self.wfile.write(b'ok')

    def log_message(self, *args):
        pass

http.server.ThreadingHTTPServer(('127.0.0.1', 18082), Handler).serve_forever()
