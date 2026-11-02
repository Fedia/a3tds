"""Deployment contract for the opaque Python frame, checked before producing a ZIP."""
from fnmatch import fnmatchcase
import json


def validate_manifest(root, manifest):
    if manifest.get('manifest_version') != 3:
        raise ValueError('Expected Manifest V3')
    if 'python-sandbox.html' not in manifest.get('sandbox', {}).get('pages', []):
        raise ValueError('Python HTML must remain a manifest sandbox page')
    sandbox_policy = manifest.get('content_security_policy', {}).get('sandbox', '')
    if 'allow-same-origin' in sandbox_policy:
        raise ValueError('Python sandbox must have an opaque origin')

    required = [
        'python-sandbox.html', 'src/python-sandbox.js', 'src/python-worker.js',
        'vendor/pyodide/pyodide.js', 'vendor/pyodide/pyodide.asm.js',
        'vendor/pyodide/pyodide.asm.wasm', 'vendor/pyodide/python_stdlib.zip',
        'vendor/pyodide/pyodide-lock.json',
    ]
    packages = json.loads((root / 'vendor/pyodide/PACKAGES.json').read_text(encoding='utf-8'))
    required.extend('vendor/pyodide/' + package['file_name'] for package in packages.values())
    for resource in required:
        if not (root / resource).is_file():
            raise ValueError('Missing Python resource: ' + resource)
        # Sandboxed about:blank and blob/null origins cannot rely on the DeepSeek match alone.
        public = any(
            '<all_urls>' in entry.get('matches', [])
            and any(fnmatchcase(resource, pattern) for pattern in entry.get('resources', []))
            for entry in manifest.get('web_accessible_resources', [])
        )
        if not public:
            raise ValueError('Opaque Python frame cannot load ' + resource +
                             ': declare it in web_accessible_resources with <all_urls>')
