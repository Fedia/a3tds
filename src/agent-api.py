"""Async browser RPC supplied by the extension. No model-facing tool protocol."""
import json as _json
import sys as _sys
import types as _types

class _Browser:
    async def _call(self, method, **arguments):
        reply = _json.loads(await _agent_rpc(method, _json.dumps(arguments)))
        if not reply['ok']:
            raise RuntimeError(reply['error'])
        return reply['data']

    async def open(self, url, new_tab=False):
        return await self._call('open', url=url, new_tab=new_tab)

    async def read(self, selector='body', tab_id=None):
        return await self._call('read', selector=selector, tab_id=tab_id)

    async def html(self, selector='body', tab_id=None):
        return await self._call('html', selector=selector, tab_id=tab_id)

    async def click(self, selector=None, *, ref=None, tab_id=None):
        return await self._call('click', selector=selector, ref=ref, tab_id=tab_id)

    async def type(self, text, selector=None, *, ref=None, tab_id=None):
        return await self._call('type', text=text, selector=selector, ref=ref, tab_id=tab_id)

    async def scroll(self, delta=600, tab_id=None):
        return await self._call('scroll', delta=delta, tab_id=tab_id)

    async def wait(self, selector, timeout=20, tab_id=None):
        return await self._call('wait', selector=selector, timeout=timeout, tab_id=tab_id)

def _progress(value):
    _agent_progress(_json.dumps(value, ensure_ascii=False, default=str))

_module = _types.ModuleType('agent')
_module.browser = _Browser()
_module.progress = _progress
_sys.modules['agent'] = _module
