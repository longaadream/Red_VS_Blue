"""Fetch pinned Android runtime packages and extract only runtime files (never run deb scripts)."""
import concurrent.futures
import hashlib
import io
import json
import os
import pathlib
import subprocess
import sys
import tarfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUT = ROOT / 'dist/android-runtime-qa'
ARCH = sys.argv[1] if len(sys.argv) > 1 else 'x86_64'
if ARCH not in ('x86_64', 'aarch64'):
    raise ValueError('Unsupported architecture')
LOCK = json.loads((ROOT / 'config/android-runtime.lock.json').read_text(encoding='utf8'))
BASE = LOCK['source']
OUT.mkdir(parents=True, exist_ok=True)


def download(url, target):
    # curl uses HTTPS_PROXY when configured; no developer-specific proxy address.
    subprocess.run(['curl.exe' if os.name == 'nt' else 'curl', '--fail', '--location', '--silent', '--show-error',
                    '--proto', '=https', '--proto-redir', '=https', '--retry', '3', '--max-time', '300',
                    url, '-o', str(target)], check=True)


selected = LOCK['architectures'][ARCH]['packages']


def fetch_package(p):
    archive = OUT / (p['Package'].replace('+', 'p') + '-' + ARCH + '.deb')
    if not archive.exists() or hashlib.sha256(archive.read_bytes()).hexdigest() != p['SHA256']:
        download(BASE + p['Filename'], archive)
    data = archive.read_bytes()
    if hashlib.sha256(data).hexdigest() != p['SHA256']:
        raise ValueError('Package SHA256 mismatch: ' + p['Package'])
    if data[:8] != b'!<arch>\n':
        raise ValueError('Not a deb archive')
    offset = 8
    while offset < len(data):
        header = data[offset:offset + 60]
        length = int(header[48:58])
        name = header[:16].decode().strip().rstrip('/')
        body = data[offset + 60:offset + 60 + length]
        offset += 60 + length + length % 2
        if not name.startswith('data.tar.'):
            continue
        with tarfile.open(fileobj=io.BytesIO(body), mode='r:*') as tar:
            for member in tar.getmembers():
                # Store selected regular files only; no symlinks or archive-controlled paths.
                path = member.name.removeprefix('./')
                prefix = 'data/data/com.termux/files/usr/'
                if not path.startswith(prefix) or not member.isfile():
                    continue
                relative = path[len(prefix):]
                if '..' in pathlib.PurePosixPath(relative).parts:
                    raise ValueError('Unsafe archive path')
                if relative == 'bin/node' or relative.startswith('lib/') and '.so' in relative or relative.startswith('share/doc/') or relative.endswith('cert.pem'):
                    dest = OUT / ARCH / relative
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    dest.write_bytes(tar.extractfile(member).read())
            for member in tar.getmembers():
                path = member.name.removeprefix('./')
                if not member.issym() or not path.startswith('data/data/com.termux/files/usr/lib/'):
                    continue
                relative = pathlib.PurePosixPath(path.split('/usr/', 1)[1])
                if '/' in member.linkname or '..' in relative.parts:
                    continue
                source = OUT / ARCH / relative.parent / member.linkname
                if source.is_file():
                    (OUT / ARCH / relative).write_bytes(source.read_bytes())
        print('Verified and extracted', p['Package'], p['Version'], ARCH, flush=True)


with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
    list(pool.map(fetch_package, selected))
for relative, expected in LOCK['architectures'][ARCH]['files'].items():
    if hashlib.sha256((OUT / ARCH / relative).read_bytes()).hexdigest() != expected:
        raise ValueError('Extracted runtime hash mismatch: ' + relative)
