"""Run with python3 .github/scripts/test_manifest.py; no third-party dependencies."""
from copy import deepcopy
import json
from pathlib import Path
import unittest
from check_manifest import validate_manifest

ROOT = Path(__file__).resolve().parents[2]
MANIFEST = json.loads((ROOT / 'manifest.json').read_text(encoding='utf-8'))


class ManifestTests(unittest.TestCase):
    def test_current_contract(self):
        validate_manifest(ROOT, MANIFEST)

    def test_missing_sandbox_html_reproduces_browser_denial(self):
        m = deepcopy(MANIFEST)
        for entry in m['web_accessible_resources']:
            entry['resources'] = [p for p in entry['resources'] if p != 'python-sandbox.html']
        with self.assertRaisesRegex(ValueError, 'python-sandbox.html'):
            validate_manifest(ROOT, m)

    def test_missing_sandbox_script(self):
        m = deepcopy(MANIFEST)
        for entry in m['web_accessible_resources']:
            entry['resources'] = [p for p in entry['resources'] if p != 'src/python-sandbox.js']
        with self.assertRaisesRegex(ValueError, 'src/python-sandbox.js'):
            validate_manifest(ROOT, m)

    def test_site_only_match_does_not_cover_opaque_python_origin(self):
        m = deepcopy(MANIFEST)
        for entry in m['web_accessible_resources']:
            entry['matches'] = ['https://chat.deepseek.com/*']
        with self.assertRaisesRegex(ValueError, 'web_accessible_resources'):
            validate_manifest(ROOT, m)

    def test_public_html_must_still_be_isolated(self):
        m = deepcopy(MANIFEST)
        m['sandbox']['pages'] = []
        with self.assertRaisesRegex(ValueError, 'sandbox page'):
            validate_manifest(ROOT, m)
        m = deepcopy(MANIFEST)
        m['content_security_policy']['sandbox'] += ' allow-same-origin'
        with self.assertRaisesRegex(ValueError, 'opaque origin'):
            validate_manifest(ROOT, m)


if __name__ == '__main__':
    unittest.main()
