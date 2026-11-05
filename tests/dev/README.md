# Разработческие проверки

Пользователю эти зависимости не нужны: обычные проверки доступны в `tests/index.html` внутри расширения, без npm и сборки.

Стенды ниже используют Python 3, Playwright и Chromium. Можно указать `CHROMIUM_BIN`; иначе используется системный `chromium`. Локальные HTTP-серверы слушают только 127.0.0.1. Chrome API эмулируются транспортным мостом Playwright; где указано, используются настоящий CDP, Web Worker, WASM/Pyodide, OPFS и IndexedDB. Это не установка расширения и не проверка авторизованного DeepSeek.

- `python tests/dev/checks.py` — 28 групп основных проверок, в том числе один Python-сценарий → два сайта-фикстуры → JSONL/CSV/отчёт в корне папки → финал. Результат сохраняется в `tests/last-results.json`.
- `python tests/dev/python-session.py` — `/project`, stdlib доступ к файлам, обновление внешних файлов, запись/перезапись/вложенные папки/rename/delete, барьер сохранения перед browser await, ошибки, остановка бесконечного цикла после checkpoint, сохранность при reload, локальный BeautifulSoup, тёплая сессия.
- `python tests/dev/python-startup.py` — семь групп ошибок Worker/WASM, явные диагностические таймауты, загрузка пакетов по необходимости, MIME fallback и отмена запуска.
- `python tests/dev/python-packages.py` — пять групп реальной установки PyPI/CDN, зависимости python-slugify, wordcloud/PNG, тёплая сессия, ограничения загрузчика и отмена. HTTPS проверяется через настроенный proxy и TLS-verified urllib.
- `python tests/dev/page-readiness.py` — настоящий CDP и scripting: DOMContentLoaded, задержанный DOM/геометрия, busy/timeout/cancel, очищенный HTML, селекторы, замена текста, переиспользование вкладок.
- `python tests/dev/python-replies.py` — восстановление Python из pre/code, идентичные ответы с разными ключами сообщений, история по подтверждениям, финал обычным текстом, повторный монтаж DOM.
- `python tests/dev/multi-chat.py` — два независимых диалога через исходники service worker/executor/UI, настоящие Workers/OPFS/браузерные вкладки; дубликат, остановка, закрытие, восстановление, настройки, скачивание, новый URL и защита от отправки в другой диалог.
- `python tests/dev/python-concurrency.py` — два настоящих Pyodide в общей папке, версии содержимого, конфликтная копия, восстановление/объединение обычным Python и принудительное перечитывание NativeFS.
- `python tests/dev/ui-layout.py` — компактные настройки и панель, светлая/тёмная темы, история и автоматический scripting fallback.
- `python tests/dev/chat-scroll.py` — высота служебных сообщений, стабильность карточек, ручная wheel/touch-прокрутка без сброса вниз.
- `python tests/dev/touch-ui.py` — перехват отправки, обычный чат, мастер привязки и отмена.
- `python tests/dev/chat-discovery.py` и `python tests/dev/deepseek-observed.py` — эвристики на искусственном/сохранённом DOM. Сохранённый DOM — исторический экспорт, не живая проверка нового протокола.

`python .github/scripts/test_manifest.py` проверяет CSP, приватность Python-ресурсов и доступность UI-модулей. `python .github/scripts/package.py` проверяет официальные контрольные суммы и создаёт `dist/deepseek-agent.zip`.
