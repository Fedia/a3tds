import {
  assert,
  hash
} from './util.js';
export const PYODIDE_CDN = 'https://cdn.jsdelivr.net/pyodide/v0.27.7/full/';
const sha256 = value => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
const packageName = value => /^[a-z0-9][a-z0-9._-]{0,99}$/i.test(value);

/** Downloads only registry metadata and verified wheel assets. Never sends request bodies or credentials. */
export class PythonPackages {
  constructor({
    fetcher = globalThis.fetch.bind(globalThis),
    onProgress = () => {},
    signal
  } = {}) {
    Object.assign(this, {
      fetcher,
      onProgress,
      signal
    });
    this.assets = new Map();
  }
  async init() {
    const response = await this.fetcher(new URL('../vendor/pyodide/pyodide-lock.json', import.meta.url));
    const lock = await response.json();
    for (const p of Object.values(lock.packages))
      if (p.file_name.endsWith('.whl') || p.package_type === 'shared_library') this.assets.set(PYODIDE_CDN + p.file_name, {
        digest: p.sha256
      });
  }
  normalize(value) {
    const url = new URL(value);
    assert(url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.search, 'Для пакетов разрешены только HTTPS URL без авторизации и параметров');
    if (url.hash) assert(/^#sha256=[a-f0-9]{64}$/i.test(url.hash), 'Неверный хеш wheel');
    const digest = url.hash.slice(8).toLowerCase();
    url.hash = '';
    return {
      url,
      digest
    };
  }
  metadata(url) {
    if (url.hostname !== 'pypi.org') return null;
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    if (parts[0] === 'simple' && parts.length === 2 && packageName(parts[1])) return 'simple';
    if (parts[0] === 'pypi' && [3, 4].includes(parts.length) && parts.at(-1) === 'json' && packageName(parts[1]) &&
      (parts.length === 3 || /^[a-z0-9._+!-]{1,100}$/i.test(parts[2]))) return 'json';
    return null;
  }
  register(data, kind) {
    const files = kind === 'simple' ? data.files || [] : [...(data.urls || []), ...Object.values(data.releases || {}).flat()];
    for (const entry of files) {
      try {
        const {
          url
        } = this.normalize(entry.url);
        const digest = entry.hashes?.sha256 || entry.digests?.sha256;
        if (url.hostname !== 'files.pythonhosted.org' || !url.pathname.endsWith('.whl') || !sha256(digest)) continue;
        this.assets.set(url.href, {
          digest: digest.toLowerCase()
        });
        const metadata = entry['core-metadata'] || entry['data-dist-info-metadata'];
        if (metadata) this.assets.set(url.href + '.metadata', {
          digest: sha256(metadata.sha256) ? metadata.sha256.toLowerCase() : null
        });
      } catch {}
    }
  }
  async read(url, contentType) {
    this.signal?.throwIfAborted();
    const response = await this.fetcher(url, {
      method: 'GET',
      credentials: 'omit',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      signal: this.signal,
      headers: contentType === 'simple' ? {
        Accept: 'application/vnd.pypi.simple.v1+json'
      } : {}
    });
    assert(response.ok, 'Не удалось загрузить пакет: HTTP ' + response.status);
    const chunks = [],
      reader = response.body?.getReader();
    let loaded = 0,
      last = 0;
    const size = Number(response.headers.get('Content-Length')) || 0;
    const label = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).at(-1) || 'метаданные');
    if (reader) {
      for (;;) {
        const {
          value,
          done
        } = await reader.read();
        if (done) break;
        chunks.push(value);
        loaded += value.length;
        if (Date.now() - last >= 500) {
          this.onProgress(`Загрузка ${label}: ${(loaded/1048576).toFixed(1)} МБ` + (size ? ` из ${(size/1048576).toFixed(1)} МБ` : ''));
          last = Date.now();
        }
      }
    } else {
      const bytes = new Uint8Array(await response.arrayBuffer());
      chunks.push(bytes);
      loaded = bytes.length;
    }
    const bytes = new Uint8Array(loaded);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return {
      bytes,
      contentType: contentType === 'simple' ? 'application/vnd.pypi.simple.v1+json' : response.headers.get('Content-Type') || 'application/octet-stream'
    };
  }
  async download(value) {
    const {
      url,
      digest
    } = this.normalize(value), kind = this.metadata(url);
    if (kind) {
      assert(!digest, 'Хеш разрешён только для wheel');
      const response = await this.read(url.href, kind);
      this.register(JSON.parse(new TextDecoder().decode(response.bytes)), kind);
      return response;
    }
    let asset = this.assets.get(url.href);
    if (!asset && url.hostname === 'files.pythonhosted.org') {
      const filename = decodeURIComponent(url.pathname.split('/').at(-1));
      const wheel = filename.match(/^([a-z0-9_.]+)-([a-z0-9_.+!]+)-.+\.whl(?:\.metadata)?$/i);
      assert(wheel && packageName(wheel[1]), 'Разрешены только wheel-файлы из индекса PyPI');
      const metadataURL = 'https://pypi.org/pypi/' + encodeURIComponent(wheel[1]) + '/' + encodeURIComponent(wheel[2]) + '/json';
      await this.download(metadataURL);
      asset = this.assets.get(url.href);
    }
    assert(asset, 'Источник пакета не разрешён: нужны PyPI или официальный CDN Pyodide ' + PYODIDE_CDN);
    assert(!digest || digest === asset.digest, 'Хеш URL не совпадает с индексом пакетов');
    const response = await this.read(url.href);
    if (asset.digest) assert(await hash(response.bytes) === asset.digest, 'SHA-256 загруженного пакета не совпадает с индексом');
    return response;
  }
}
