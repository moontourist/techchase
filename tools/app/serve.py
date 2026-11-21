import functools
import http.server
import json
import os
import shutil
import subprocess
import sys
import threading
import webbrowser

HERE = os.path.dirname(os.path.abspath(__file__))
PORT = 8473
sys.path.insert(0, os.path.dirname(HERE))
import dolphin_setup  # noqa: E402  tools/ is put on the path just above

DOLPHIN_INSTALLS = None

def browser():
    for p in (r"C:\Program Files\Google\Chrome\Application\chrome.exe",
              r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
              r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
              r"C:\Program Files\Microsoft\Edge\Application\msedge.exe"):
        if os.path.exists(p):
            return p
    return shutil.which('google-chrome') or shutil.which('chromium') or shutil.which('microsoft-edge')

class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def _json(self, code, body):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _same_origin(self):
        host = self.headers.get('Host', '')
        origin = self.headers.get('Origin')
        return (host.startswith('127.0.0.1:') and self.headers.get('X-Techchase') == '1'
                and origin == f'http://{host}')

    def do_GET(self):
        if self.path.split('?')[0] == '/api/dolphin':
            if not self.headers.get('Host', '').startswith('127.0.0.1:'):
                return self._json(403, {'error': 'wrong host'})
            return self._json(200, dolphin_setup.check(DOLPHIN_INSTALLS))
        return super().do_GET()

    def do_POST(self):
        if self.path != '/api/dolphin/fix':
            return self._json(404, {'error': 'not found'})
        if not self._same_origin():
            return self._json(403, {'error': 'only the app page itself can change Dolphin settings'})
        try:
            body = json.loads(self.rfile.read(min(int(self.headers.get('Content-Length', 0)), 4096)) or b'{}')
            out = dolphin_setup.write_profile(DOLPHIN_INSTALLS, str(body.get('install')), int(body.get('port')))
        except (ValueError, TypeError, RuntimeError, OSError) as e:
            return self._json(400, {'error': str(e)})
        return self._json(200, out)

Quiet.extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, '.js': 'text/javascript'}

def main():
    global DOLPHIN_INSTALLS
    port = int(sys.argv[sys.argv.index('--port') + 1]) if '--port' in sys.argv else PORT
    if '--dolphin-root' in sys.argv:
        DOLPHIN_INSTALLS = dolphin_setup.installs_in(sys.argv[sys.argv.index('--dolphin-root') + 1])
    srv = http.server.ThreadingHTTPServer(('127.0.0.1', port), functools.partial(Quiet, directory=HERE))
    url = f"http://127.0.0.1:{port}/" + ('?demo' if '--demo' in sys.argv else '')
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    exe = None if '--no-browser' in sys.argv else browser()
    if '--no-browser' in sys.argv:
        pass
    elif exe:
        subprocess.Popen([exe, f'--app={url}'])
    else:
        webbrowser.open(url)
    print(f"techchase app at {url}  (Ctrl+C to stop)")
    try:
        threading.Event().wait()
    except KeyboardInterrupt:
        srv.shutdown()

if __name__ == '__main__':
    main()
