"""Validate the private, persistent Python Worker and packaged runtime contract."""
from fnmatch import fnmatchcase
import json

def validate_manifest(root, manifest):
    if manifest.get('manifest_version') != 3:
        raise ValueError('Expected Manifest V3')
    if manifest.get('sandbox', {}).get('pages'):
        raise ValueError('Persistent Python must not depend on a sandbox iframe')
    policy=manifest.get('content_security_policy',{}).get('extension_pages','')
    directives={part.strip().split()[0]:part.strip().split()[1:] for part in policy.split(';') if part.strip()}
    if directives.get('worker-src') != ["'self'"]:
        raise ValueError('worker-src must load only packaged workers')
    if set(directives.get('script-src',[])) != {"'self'","'wasm-unsafe-eval'"}:
        raise ValueError('script-src must allow local JS and WASM only')
    required=['src/python-runtime.js','src/python-worker.js','src/python-packages.js','src/tool-format.js',
              'vendor/pyodide/pyodide.js','vendor/pyodide/pyodide.asm.js','vendor/pyodide/pyodide.asm.wasm',
              'vendor/pyodide/python_stdlib.zip','vendor/pyodide/pyodide-lock.json','vendor/pyodide/PACKAGES.json']
    packages=json.loads((root/'vendor/pyodide/PACKAGES.json').read_text(encoding='utf-8'))
    required += ['vendor/pyodide/'+p['file_name'] for p in packages.values()]
    for resource in required:
        if not (root/resource).is_file():raise ValueError('Missing Python resource: '+resource)
    private=[p for p in required if p!='src/tool-format.js']
    for entry in manifest.get('web_accessible_resources',[]):
        if any(fnmatchcase(resource,pattern) for resource in private for pattern in entry.get('resources',[])):
            raise ValueError('Python Worker/runtime must remain private extension resources')

    public=['executor.html','src/chat-dom.js','src/final-view.js','src/ui-state.js','src/chat-scroll.js','src/tool-format.js']
    for resource in public:
        if not (root/resource).is_file() or not any(
            'https://chat.deepseek.com/*' in entry.get('matches',[])
            and any(fnmatchcase(resource,pattern) for pattern in entry.get('resources',[]))
            for entry in manifest.get('web_accessible_resources',[])):
            raise ValueError('Missing DeepSeek UI resource access: '+resource)
