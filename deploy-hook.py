#!/usr/bin/env python3
from http.server import HTTPServer, BaseHTTPRequestHandler
import subprocess, os
import re

TOKEN = os.environ.get('DEPLOY_TOKEN', '')
REPO  = '/root/UrumAutoTrader'

GITHUB_TOKEN_RE = re.compile(r'github_pat_[A-Za-z0-9_]+')
URL_CRED_RE = re.compile(r'https://([^:/@\s]+):([^@\s]+)@')

def redact(text: str) -> str:
    text = GITHUB_TOKEN_RE.sub('github_pat_[REDACTED]', text)
    text = URL_CRED_RE.sub(r'https://\1:[REDACTED]@', text)
    return text

def run_or_raise(args, **kwargs):
    result = subprocess.run(args, check=True, capture_output=True, text=True, **kwargs)
    return result

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
            run_or_raise(['git', '-C', REPO, 'pull', 'origin', 'main'])

            # Build backend
            run_or_raise(['npm', 'run', 'build'], cwd=f'{REPO}/backend')

            # Deploy backend dist into running container
            run_or_raise([
                'docker', 'cp', f'{REPO}/backend/dist/.', 'urumautotrader-backend-1:/app/dist/'
            ])
            run_or_raise(['docker', 'restart', 'urumautotrader-backend-1'])

            # Build frontend
            env = os.environ.copy()
            env['VITE_API_URL']      = '/api'
            env['VITE_USER_ADDRESS'] = '0xbb75Bd3585DD162bd18b08501757B7371218af85'
            run_or_raise(['npm', 'run', 'build'], cwd=f'{REPO}/frontend', env=env)

            # Deploy frontend dist into running container
            run_or_raise([
                'docker', 'cp', f'{REPO}/frontend/dist/.', 'urumautotrader-frontend-1:/usr/share/nginx/html/'
            ])
            run_or_raise([
                'docker', 'exec', 'urumautotrader-frontend-1', 'nginx', '-s', 'reload'
            ])

            self.send_response(200); self.end_headers(); self.wfile.write(b'ok')
        except subprocess.CalledProcessError as e:
            stdout = redact((e.stdout or '').strip())
            stderr = redact((e.stderr or '').strip())
            parts = [f'Deploy failed: command exited with status {e.returncode}.']
            if stdout:
                parts.append(f'STDOUT:\n{stdout}')
            if stderr:
                parts.append(f'STDERR:\n{stderr}')
            msg = '\n\n'.join(parts).encode()
            self.send_response(500); self.end_headers(); self.wfile.write(msg)

HTTPServer(('0.0.0.0', 5051), Handler).serve_forever()
