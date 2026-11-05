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

## Возможности и ограничения

- `GET /healthz`: доступность HTTP-сервера, без проверки Google.
- `GET /v1/models`: доступные модели аккаунта и псевдоним `agy-default`.
- `POST /v1/chat/completions`: текст, история сообщений, system/developer, SSE, `stream_options.include_usage`, `stop`, `reasoning_effort`.
- Настоящий поток текста из событий `step_update.text_delta` CLI. Время до первого текста зависит от запуска CLI и модели.
- Function tools, `tool_choice`, `parallel_tool_calls`: JSON-подсказка с проверкой аргументов по схеме. Выполнение инструментов остаётся на клиенте. Это адаптация через промпт, поэтому возможен отказ с 502 при некорректном ответе модели.
- `response_format: {"type":"json_object"}`: проверяемый JSON-объект. JSON и вызовы функций буферизуются до проверки, затем отправляются в SSE.
- Поддерживается только Chat Completions subset, не весь OpenAI API: нет Responses, embeddings, изображений, аудио, JSON Schema response format. `n` только 1.
- Параметры `temperature`, `top_p`, `max_tokens`, `max_completion_tokens` и другие неподдерживаемые настройки возвращают 400. Отключите их в клиенте.
- Каждый запрос запускает отдельный CLI в временной папке с отключёнными встроенными инструментами. Историю передаёт клиент; сервер её не хранит. Обрыв клиента отменяет процесс.
- Один общий аккаунт Google и ключ API на экземпляр сервера. Административные методы `/admin/*` требуют тот же ключ. Необработанные ошибки CLI, промпты и коды входа не выводятся в HTTP-ответах или логах сервера.

## Необязательные настройки

Скопируйте `.env.example` в `.env`, если нужны изменения. Основные переменные:

| Переменная | По умолчанию | Назначение |
| --- | --- | --- |
| `PORT` | `44455` | Порт хоста |
| `BIND_ADDRESS` | `0.0.0.0` | Все интерфейсы; `127.0.0.1` для доступа только с хоста |
| `AGY_API_KEY` | Генерируется | Собственный ключ, минимум 16 символов |
| `AGY_DEFAULT_MODEL` | Выбор CLI | Модель для `agy-default` |
| `AGY_MAX_CONCURRENCY` | `2` | Одновременные процессы генерации |
| `AGY_MAX_QUEUE` | `16` | Ожидающие запросы, далее 429 |
| `AGY_REQUEST_TIMEOUT_MS` | `180000` | Таймаут вместе с ожиданием очереди |

При внешнем доступе используйте HTTPS через свой reverse proxy; отключите буферизацию SSE. Ответ сервера содержит `X-Accel-Buffering: no`.

## Разработка

Node.js 22+. Из папки `docker`: `npm ci`, `npm test`, `npm start`. Локально также можно использовать установленный CLI через `AGY_EXECUTABLE=/path/to/agy`; без него работает автоматическая установка. Docker сборка использует весь репозиторий как контекст для общих модулей CLI/auth, но не устанавливает n8n.

Тесты используют официальный OpenAI JavaScript SDK, проверяют раннюю доставку SSE, функции, остановку текста, очередь и ошибки. Формат: [Chat Completions](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create).
