# Agy OpenAI-compatible API

Отдельное приложение без n8n. Поднимает HTTP API и страницу входа в Google.

## Запуск

Из клонированного репозитория:

```sh
cd docker
docker compose up
```

Первый запуск собирает образ и скачивает проверенный по SHA-512 Agy CLI 1.5.1. Нужен интернет. Поддерживаются Linux amd64 и arm64. После старта контейнера API и страница настройки доступны на **http://localhost:44455**. `.env` и ручная установка CLI не требуются.

1. Скопируйте `Generated API key` из логов контейнера.
2. Откройте http://localhost:44455 и вставьте ключ.
3. Нажмите вход через Google, откройте полученную ссылку и вставьте код/URL обратного перенаправления на страницу настройки.
4. Обновите модели и отправьте пробный запрос прямо на странице.

HTTP-сервер доступен сразу, но генерация требует первого входа в Google. Обойти авторизацию аккаунта автоматически нельзя. Авторизация, ключ API и CLI сохраняются в локальных папках `docker/data/auth`, `docker/data/api` и `docker/data/runtime`; после перезапуска вход повторять не нужно. Ключ этого сервера используется вместо ключа OpenAI.

Получить сохранённый ключ позднее:

```sh
docker compose exec agy-api cat /home/node/.agy-api/api-key
```

Фоновый запуск: `docker compose up -d`. После обновления исходников: `docker compose up -d --build`. `docker compose down` и `docker compose down -v` сохраняют локальные данные. Папка `docker/data` исключена из Git и контекста сборки. При первом запуске папки создаются автоматически; entrypoint настраивает права и копирует CLI из образа, затем запускает приложение от пользователя `node` (UID 1000).

### Переход с прежних named volumes

Старые Docker volumes не удаляются и автоматически не мигрируются. Если уже авторизовались в предыдущей версии, перенесите данные **до запуска новой версии** (имена volumes ниже соответствуют стандартному имени Compose-проекта `docker`; при другом имени замените префикс):

```sh
docker compose down
mkdir -p data/auth data/api data/runtime
docker run --rm -v docker_agy-auth:/source:ro -v "$PWD/data/auth:/target" alpine sh -c 'cp -a /source/. /target/'
docker run --rm -v docker_agy-api-data:/source:ro -v "$PWD/data/api:/target" alpine sh -c 'cp -a /source/. /target/'
docker run --rm -v docker_agy-runtime:/source:ro -v "$PWD/data/runtime:/target" alpine sh -c 'cp -a /source/. /target/'
docker compose up -d --build
```

Без переноса приложение создаст новый ключ API и потребует повторного входа в Google.

## Подключение

- Base URL: `http://localhost:44455/v1`
- API key: ключ из логов/файла
- Model: `agy-default` или ID из `GET /v1/models`

```sh
export AGY_API_KEY='ваш-ключ'
curl http://localhost:44455/v1/chat/completions \
  -H "Authorization: Bearer $AGY_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"model":"agy-default","stream":true,"messages":[{"role":"user","content":"Привет!"}]}'
```

Официальный Python SDK:

```python
import os
from openai import OpenAI
client = OpenAI(base_url="http://localhost:44455/v1", api_key=os.environ["AGY_API_KEY"])
for chunk in client.chat.completions.create(
    model="agy-default", messages=[{"role": "user", "content": "Привет!"}], stream=True
):
    if chunk.choices:
        print(chunk.choices[0].delta.content or "", end="", flush=True)
```

Из другого контейнера в общей Docker-сети используйте `http://agy-api:8080/v1`. `localhost` внутри контейнера указывает на него самого. Compose по умолчанию публикует порт на всех интерфейсах хоста (`0.0.0.0`). С другой машины используйте `http://<IP-сервера>:44455/v1`.

## n8n OpenAI Chat Model

В credential задайте Base URL `http://<IP-сервера>:44455/v1` и ключ этого сервера. В узле **OpenAI Chat Model** выключите **Use Responses API**: сервер реализует Chat Completions (`/v1/chat/completions`), а не `/v1/responses`. Выберите модель из списка. Для системных инструкций используйте сообщения цепочки/агента n8n.

## Системные инструкции

Docker API не добавляет стандартный системный промпт, персону или инструкции адаптера. Текст из `messages` с ролями `system` и `developer` передаётся в пользовательский агент Agy, в исходном порядке, с двумя переводами строки между сообщениями. Без этих сообщений системный текст пустой.

```json
{
  "model": "gemini-3.8-flash-medium",
  "messages": [
    {"role": "system", "content": "Отвечай кратко и на русском."},
    {"role": "user", "content": "Привет!"}
  ]
}
```

Одиночное пользовательское сообщение передаётся без обёртки. История сериализуется в JSON, поскольку CLI принимает один пользовательский turn. При явном запросе tools/JSON формат передаётся в пользовательских данных запроса, не добавляется к системному промпту. Встроенные инструменты Agy отключены настройкой агента. Внутренние инструкции самого Agy и провайдера находятся вне контроля этого адаптера. Эти изменения относятся к Docker API.

## Дополнительная проверка Google

Доступный список моделей ещё не гарантирует, что Google разрешил генерацию. Если CLI сообщает `VALIDATION_REQUIRED` или требование подтвердить аккаунт, API возвращает `error.code: account_verification_required`, HTTP 403 и `error.verification_url`, когда удалось извлечь ссылку Google. В уже начатом SSE-потоке ошибка передаётся событием `data`, затем `[DONE]`.

Откройте страницу настройки, введите ключ API и нажмите «Проверить подключение»: она покажет последнюю ссылку проверки. После подтверждения повторите запрос. Ссылка хранится только в памяти до 10 минут и очищается после успешной генерации. Её не записывают в логи. Без распознанной ссылки API всё равно сообщает о необходимости проверки; получить ссылку можно при прямом запуске CLI. Распознаются известные формулировки ошибок, поэтому новые форматы CLI могут потребовать обновления.

## Возможности и ограничения

- `GET /healthz`: доступность HTTP-сервера, без проверки Google.
- `GET /v1/models`: доступные модели аккаунта и псевдоним `agy-default`.
- `POST /v1/chat/completions`: текст, история сообщений, system/developer, SSE, `stream_options.include_usage`, `stop`, `reasoning_effort`.
- Настоящий поток текста из событий `step_update.text_delta` CLI, в том числе когда клиент (например OpenCode) передаёт tools. Из JSON-конверта по мере поступления извлекается только верхнеуровневый `content`; JSON-обёртка и аргументы инструментов не выводятся как текст. Время до первого текста зависит от запуска CLI и модели.
- Function tools, `tool_choice`, `parallel_tool_calls`: JSON-формат в пользовательском запросе с проверкой аргументов по схеме. Выполнение инструментов остаётся на клиенте. Это адаптация через промпт, поэтому возможен отказ с 502 при некорректном ответе модели.
- `response_format: {"type":"json_object"}`: проверяемый JSON-объект. Режим JSON без tools и сами вызовы функций буферизуются до проверки, затем отправляются в SSE. Обычный текст в tool-конверте передаётся вживую; при последующей ошибке валидации SSE завершается ошибкой без отправки некорректных tool calls.
- Поддерживается только Chat Completions subset, не весь OpenAI API: нет Responses, embeddings, входных изображений в chat, аудио, JSON Schema response format. Генерация изображений доступна отдельным endpoint ниже. `n` только 1.
- Параметры `temperature`, `top_p`, `max_tokens`, `max_completion_tokens` и другие неподдерживаемые настройки возвращают 400. Отключите их в клиенте.
- Каждый chat-запрос запускает отдельный CLI в временной папке с отключёнными встроенными инструментами. Историю передаёт клиент; при включённом логировании она попадает в логи запросов. Обрыв клиента отменяет процесс.
- Один общий аккаунт Google и ключ API на экземпляр сервера. Административные методы `/admin/*` требуют тот же ключ. Необработанные ошибки CLI не выводятся в HTTP-ответах или логах сервера. Входящие промпты записываются в логи запросов; поля авторизации и коды входа скрываются.

## Логи запросов

Тела входящих запросов по умолчанию пишутся в stdout одной JSON-строкой с `event: "http_request"`, временем, методом, путём и `request_id` (также возвращается в заголовке `x-request-id`). Запись появляется после получения тела, до завершения генерации. Включены запросы к неизвестным endpoint и отклонённые запросы.

Из папки `docker`:

```sh
docker compose logs --tail=100 -f agy-api
```

Для просмотра только запросов с форматированием JSON (если установлен `jq`):

```sh
docker compose logs --no-log-prefix agy-api | jq -R 'fromjson? | select(.event == "http_request")'
```

В логах видны сообщения, system prompt, tools и параметры генерации. Заголовки и query string не записываются; JSON-поля API-ключей, токенов, паролей и `/admin/*` поле `code` заменяются на `[REDACTED]`. Секреты внутри произвольного текста промпта автоматически не распознаются. Для запросов без тела выводится `null`; некорректный JSON, прерванные тела и тела больше 1 MiB заменяются маркером причины пропуска.

Чтобы отключить запись, установите `AGY_LOG_REQUESTS=false` в `.env` и выполните `docker compose up -d`. После обновления кода пересоберите контейнер: `docker compose up -d --build`.

## Необязательные настройки

Скопируйте `.env.example` в `.env`, если нужны изменения. Основные переменные:

| Переменная | По умолчанию | Назначение |
| --- | --- | --- |
| `PORT` | `44455` | Порт хоста |
| `BIND_ADDRESS` | `0.0.0.0` | Все интерфейсы; `127.0.0.1` для доступа только с хоста |
| `AGY_API_KEY` | Генерируется | Собственный ключ, минимум 16 символов |
| `AGY_DEFAULT_MODEL` | Выбор CLI | Модель для `agy-default` |
| `AGY_LOG_REQUESTS` | `true` | Логировать тела входящих запросов; `false` отключает |
| `AGY_MAX_CONCURRENCY` | `2` | Одновременные процессы генерации |
| `AGY_MAX_QUEUE` | `16` | Ожидающие запросы, далее 429 |
| `AGY_REQUEST_TIMEOUT_MS` | `180000` | Таймаут вместе с ожиданием очереди |

При внешнем доступе используйте HTTPS через свой reverse proxy; отключите буферизацию SSE. Ответ сервера содержит `X-Accel-Buffering: no`.

## Разработка

Node.js 22+. Из папки `docker`: `npm ci`, `npm test`, `npm start`. Локально также можно использовать установленный CLI через `AGY_EXECUTABLE=/path/to/agy`; без него работает автоматическая установка. Docker сборка использует весь репозиторий как контекст для общих модулей CLI/auth, но не устанавливает n8n.

Тесты используют официальный OpenAI JavaScript SDK, проверяют раннюю доставку SSE, функции, остановку текста, очередь и ошибки. Формат: [Chat Completions](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create).

## Генерация изображений

`POST /v1/images/generations` использует тот же API-ключ и сохранённый аккаунт Google:

```sh
curl http://localhost:44455/v1/images/generations \
  -H "Authorization: Bearer $AGY_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"model":"agy-image","prompt":"Акварель: оранжевая лодка на горном озере на рассвете","n":1,"response_format":"b64_json"}'
```

Ответ содержит `created` и `data[0].b64_json`. Дополнительные поля `mime_type`, `file_name`, `width`, `height` описывают фактический файл. Их использует готовый n8n workflow. Ответ совместим с `client.images.generate(...)` OpenAI SDK.

- `agy-image` — псевдоним маршрута, не выбор конкретной модели изображений; он не добавлен в список chat-моделей `/v1/models`.
- Поддерживаются один результат (`n: 1`) и base64. `size`, `quality`, `style`, URL-ответы, редактирование и streaming изображений пока не поддерживаются. Визуальные предпочтения можно указать в prompt, но точные размеры не гарантируются.
- Image runner использует отдельного пользовательского агента Agy с инструментом `generate_image`. Его служебные инструкции относятся только к image endpoint, а не к системным промптам chat API.
- Возвращается последний валидный PNG/JPEG/WebP артефакт из текущего запуска, до 10 MiB. Текст модели с произвольным путём к файлу не используется. Если изображения нет, API возвращает 502 `image_not_generated`.
- Изображения и conversation artifacts этого запуска удаляются после чтения результата или ошибки. Если необходимо сохранить изображение, сохраните ответ в n8n. Аварийное завершение контейнера может оставить artifacts в `data/auth/antigravity-cli/brain`.
- Ошибка image tool обрабатывается даже если CLI завершился со статусом SUCCESS: исчерпание квоты возвращает HTTP 429 `image_quota_exceeded`, временный rate limit — `image_rate_limit_exceeded`, другая ошибка инструмента — 502 `image_generation_failed`. Если Google передал задержку, ответ содержит `Retry-After` и `error.retry_after_seconds`. Не повторяйте генерацию до указанного времени.
- Отключение клиента отменяет процесс. Генерации не повторяются автоматически; повтор HTTP-запроса может снова расходовать квоту.

Настройки в `.env`:

| Переменная | По умолчанию | Назначение |
| --- | --- | --- |
| `AGY_IMAGE_AGENT_MODEL` | Выбор CLI | Reasoning-модель, вызывающая image tool; не модель генерации изображения |
| `AGY_IMAGE_TIMEOUT_MS` | `240000` | Таймаут изображения вместе с ожиданием очереди |
| `AGY_IMAGE_CONCURRENCY` | `1` | Одновременные image-процессы |
| `AGY_IMAGE_MAX_QUEUE` | `4` | Очередь изображений, далее 429 |

Очередь изображений независима от chat-запросов, но квота аккаунта Google общая. Для n8n используйте HTTP timeout больше серверного (в примере 300000 мс).

### AI Agent → изображение → Telegram

Готовые импортируемые workflow и настройка: [examples/README.md](examples/README.md).

1. Импортируйте [telegram-image-tool.json](examples/telegram-image-tool.json), задайте URL сервера и credentials HTTP Header Auth/Telegram.
2. Импортируйте [telegram-image-agent.json](examples/telegram-image-agent.json), подключите Telegram/OpenAI credentials и выберите первый workflow в tool.
3. Получатель берётся из Telegram Trigger; AI задаёт только prompt. В модель возвращается только подтверждение доставки, не base64 изображения.

## OpenCode 1.x

Готовый config: [examples/opencode.json](examples/opencode.json). Формат проверен установленным OpenCode 1.18.34. Он использует `@ai-sdk/openai-compatible` и Chat Completions, как описано в [официальной документации OpenCode](https://opencode.ai/docs/providers).

1. Обновите сервер (`git pull`, затем из `docker` — `docker compose up -d --build`): OpenCode использует tool schemas JSON Schema 2020-12, поддержка которых добавлена в этой версии.
2. Скопируйте `docker/examples/opencode.json` в корень проекта, где запускаете OpenCode, под именем `opencode.json`. Если config уже есть, объедините раздел `provider.agy` и настройки моделей с существующим файлом.
3. В config замените `provider.agy.options.baseURL`, если адрес сервера отличается от `http://192.168.1.100:44455/v1`.
4. В терминале, из которого запускаете OpenCode:

```sh
export AGY_API_KEY='ключ-нашего-Docker-API'
opencode
```

Через `/models` доступны четыре модели Agy: Gemini 3.8 Flash, Gemini 4 Argon, Claude Sonnet 5.5 и Claude Opus 5.5 (варианты medium). Наличие зависит от аккаунта; при необходимости измените IDs по ответу `/v1/models`.

В `options` каждой модели намеренно стоят `null` для `max_tokens`, `max_completion_tokens`, `temperature`, `top_p` и penalties: это нейтрализует автоматически добавляемые OpenCode настройки, которыми Agy CLI не умеет управлять. Не удаляйте эти overrides. OpenCode передаёт свои системные инструкции через API; настройки инструментов и разрешений остаются под контролем OpenCode. Эта конфигурация предназначена для текстовых запросов и tool calling; image endpoint не подключается автоматически.

Проверка совместимости: настоящий OpenCode 1.18.34 подключён к локальному HTTP-серверу с тестовым backend и успешно получил ответ с включёнными coding tools. Это проверяет формат запросов/ответов, а не качество реального выполнения coding-задач. Для OpenCode 2.x используется другой формат конфигурации (`providers`/`package`/`settings`).

### Автоматический список моделей OpenCode

OpenCode 1.x можно расширить локальным startup-плагином. Готовый файл: [agy-models.js](examples/opencode-plugins/agy-models.js).

Скопируйте его в проект, где уже лежит `opencode.json`:

```sh
mkdir -p /path/to/your/project/.opencode/plugins
cp docker/examples/opencode-plugins/agy-models.js /path/to/your/project/.opencode/plugins/agy-models.js
```

Затем запустите OpenCode из этого проекта с `AGY_API_KEY` в окружении. Плагин автоматически читает `provider.agy.options.baseURL`, запрашивает `/models` (то есть `/v1/models` при Base URL с `/v1`) и заполняет список всех доступных chat-моделей. Каждая модель получает необходимые null-overrides для неподдерживаемых CLI параметров. Статический список из config можно оставить как fallback.

- Список обновляется при старте OpenCode, а не при каждом запросе. После смены аккаунта перезапустите OpenCode и откройте `/models`.
- Если fetch не удался (timeout 15 секунд, неверный ключ, недоступность сервера), сохраняется статический список config; причина без ключа/response body пишется в журнал OpenCode.
- Новые модели добавляются, пропавшие удаляются из runtime-конфигурации. Если выбранный default Agy исчез, используется `agy-default` или первая доступная модель. Другие providers не меняются.
- Config на диске и ключи не перезаписываются. Используйте `AGY_API_KEY` или `provider.agy.options.apiKey`; auth из `/connect` этот плагин отдельно не читает.
- `--pure` отключает внешние плагины: запускайте OpenCode без него для discovery.
- Проверено реальным OpenCode 1.18.34: обнаружена и выбрана модель, которой не было в статическом config. Backend генерации в этом тесте был тестовым.

Если OpenCode пишет **Invalid tool JSON schema**, сначала обновите и пересоберите API-сервер: поддержка OpenCode JSON Schema 2020-12 добавлена в commit `c29ef50`. Копирование config или плагина без обновления контейнера не обновляет API.
