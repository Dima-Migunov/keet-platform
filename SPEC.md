# keet-platform — Спецификация

## Архитектура (V3 — Hyperdrive)

```
Pear Runtime (pear run .)
  └── bridge/index.js
       ├── Corestore + Hyperdrive (P2P filesystem)
       ├── Hyperswarm + Pear DHT (88 bootstrap nodes, same as Keet)
       ├── JsonStdio (stdin/stdout JSON для Hermes adapter)
       └── messages/ (файлы-сообщения в Hyperdrive)
            ├── <timestamp>-<id>.json  (от телефона)
            └── response-<ts>-<id>.json (от Hermes)
```

**Ключевое**: bridge запускается через Pear Runtime, а не Node.js. Pear подтягивает:
- `Pear.config.dht.nodes` — правильные DHT bootstrap ноды (88 шт., Holepunch/Keet)
- `Pear.config.storage` — изолированное хранилище для Corestore
- Relay-ноды для обхода мобильного NAT

## Жизненный цикл

1. Bridge стартует → `pear run .`
2. Создаёт/загружает Corestore + Hyperdrive
3. Присоединяется к DHT через `Pear.config.dht.nodes`
4. Джойнит swarm topic = `drive.discoveryKey`
5. Выводит invite: `keet://<drive-key-hex>`
6. Пользователь отправляет ссылку на телефон → Keet
7. Keet открывает `keet://<hex>` → присоединяется к тому же Hyperdrive
8. Телефон пишет файлы в `messages/` → bridge читает → stdio → Hermes
9. Hermes отвечает → bridge пишет файл → Hyperdrive реплицирует → телефон

## JSON stdio протокол

### События (bridge → adapter, stdout)
```json
{"type":"identity","public_key":"keet://<driveKey>","profile_discovery_key":"<driveKey>"}
{"type":"welcome_room_ready","room_key":"<driveKey>"}
{"type":"member_joined","pubkey":"...","room_key":"<driveKey>","status":"connected"}
{"type":"member_left","pubkey":"...","room_key":"<driveKey>"}
{"type":"message","chat_id":"<driveKey>","from":"keet-user","text":"...","ts":...}
{"type":"send_result","chat_id":"...","status":"ok","peers":N}
{"type":"status","status":"online","mode":"hyperdrive","invite_url":"keet://...","topic_key":"...","peerCount":N}
```

### Команды (adapter → bridge, stdin)
```json
{"command":"send_message","chat_id":"<driveKey>","text":"..."}
{"command":"status"}
{"command":"get_identity"}
```

## Запуск

```bash
# Development (Node.js)
node index.js

# Production (Pear Runtime — правильная DHT сеть)
pear run .
```

## Зависимости

```
b4a ^1.8.1
corestore ^6.0.0
hypercore-crypto ^3.7.0
hyperdrive ^11.0.0
hyperswarm ^4.17.0
```

## Переменные окружения

| Переменная | Описание |
|------------|----------|
| `KEET_HOME_CHANNEL` | Home channel для адаптера |
| `KEET_ALLOWED_USERS` | Список разрешённых pubkey |
| `KEET_ALLOW_ALL_USERS` | `true` — разрешить всех |

## История версий

- **V1** (blind-pairing + Hypercore) — не работало из-за разных DHT сетей
- **V2** (простой Hyperswarm topic) — не работало, т.к. Keet не принимает hex-ключи
- **V3** (Pear + Hyperdrive + `keet://<driveKey>`) — текущая, использует правильную DHT сеть
