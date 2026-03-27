#!/usr/bin/env python3
from http.server import HTTPServer, BaseHTTPRequestHandler
import subprocess, os

TOKEN = os.environ.get('DEPLOY_TOKEN', '')
REPO  = '/home/user/UrumAutoTrader'

class Handler(BaseHTTPRequestHandler):
    def log_message(self, format, *args): pass

    def do_POST(self):
        if self.headers.get('X-Deploy-Token') != TOKEN or not TOKEN:
            self.send_response(401); self.end_headers(); return

        # Drain any body (ignored)
        length = int(self.headers.get('Content-Length', 0) or 0)
        if length: self.rfile.read(length)

        try:
            # Pull latest code
            subprocess.run(['git', '-C', REPO, 'pull', 'origin', 'main'], check=True)

            # Build backend
            subprocess.run(['npm', 'run', 'build'], cwd=f'{REPO}/backend', check=True)

            # Deploy backend dist into running container
            subprocess.run([
                'docker', 'cp', f'{REPO}/backend/dist/.', 'urumautotrader-backend-1:/app/dist/'
            ], check=True)
            subprocess.run(['docker', 'restart', 'urumautotrader-backend-1'], check=True)

            # Build frontend
            env = os.environ.copy()
            env['VITE_API_URL']      = '/api'
            env['VITE_USER_ADDRESS'] = '0xbb75Bd3585DD162bd18b08501757B7371218af85'
            subprocess.run(['npm', 'run', 'build'], cwd=f'{REPO}/frontend', env=env, check=True)

            # Deploy frontend dist into running container
            subprocess.run([
                'docker', 'cp', f'{REPO}/frontend/dist/.', 'urumautotrader-frontend-1:/usr/share/nginx/html/'
            ], check=True)
            subprocess.run([
                'docker', 'exec', 'urumautotrader-frontend-1', 'nginx', '-s', 'reload'
            ], check=True)

            self.send_response(200); self.end_headers(); self.wfile.write(b'ok')
        except subprocess.CalledProcessError as e:
            msg = f'Deploy failed: {e}'.encode()
            self.send_response(500); self.end_headers(); self.wfile.write(msg)

HTTPServer(('0.0.0.0', 5051), Handler).serve_forever()
