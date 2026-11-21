"""Open the techchase app: serves this folder on http://127.0.0.1 (WebUSB needs a secure origin,
which localhost is) and opens it in Chrome or Edge.

  python tools/app/serve.py            (Ctrl+C to stop)
  python tools/app/serve.py --demo     (no controller needed)
  python tools/app/serve.py --no-browser --port 8474   (just serve)
"""
import functools
import http.server
import os
import shutil
import subprocess
import sys
import threading
import webbrowser

HERE = os.path.dirname(os.path.abspath(__file__))
PORT = 8473


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


Quiet.extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, '.js': 'text/javascript'}


def main():
    port = int(sys.argv[sys.argv.index('--port') + 1]) if '--port' in sys.argv else PORT
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
