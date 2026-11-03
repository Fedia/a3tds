"""Static MV3 Worker/CSP regressions, no third-party dependencies."""
from copy import deepcopy
import json
from pathlib import Path
import unittest
from check_manifest import validate_manifest
ROOT=Path(__file__).resolve().parents[2]
MANIFEST=json.loads((ROOT/'manifest.json').read_text(encoding='utf-8'))
class ManifestTests(unittest.TestCase):
    def test_current_contract(self):validate_manifest(ROOT,MANIFEST)
    def test_blob_worker_not_required(self):
        m=deepcopy(MANIFEST);m['content_security_policy']['extension_pages']=m['content_security_policy']['extension_pages'].replace("worker-src 'self'","worker-src blob:")
        with self.assertRaisesRegex(ValueError,'worker-src'):validate_manifest(ROOT,m)
    def test_no_remote_js_or_eval(self):
        for source in ['https://cdn.jsdelivr.net',"'unsafe-eval'"]:
            m=deepcopy(MANIFEST);m['content_security_policy']['extension_pages']=m['content_security_policy']['extension_pages'].replace("script-src 'self'", "script-src 'self' "+source)
            with self.assertRaisesRegex(ValueError,'script-src'):validate_manifest(ROOT,m)
    def test_worker_cannot_be_loaded_by_sites(self):
        m=deepcopy(MANIFEST);m['web_accessible_resources'].append({'resources':['src/python-worker.js'],'matches':['<all_urls>']})
        with self.assertRaisesRegex(ValueError,'private'):validate_manifest(ROOT,m)
    def test_ui_module_imports_remain_accessible(self):
        m=deepcopy(MANIFEST)
        for entry in m['web_accessible_resources']:entry['resources']=[r for r in entry['resources'] if r!='src/tool-format.js']
        with self.assertRaisesRegex(ValueError,'tool-format.js'):validate_manifest(ROOT,m)
    def test_no_nested_python_frame(self):
        m=deepcopy(MANIFEST);m['sandbox']={'pages':['python-sandbox.html']}
        with self.assertRaisesRegex(ValueError,'sandbox iframe'):validate_manifest(ROOT,m)
if __name__=='__main__':unittest.main()
