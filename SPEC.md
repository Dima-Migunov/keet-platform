# keet-platform — Спецификация библиотек

## Архитектура плагина

- **adapter.py** — Python-адаптер для Hermes, запускает bridge как subprocess через asyncio
- **bridge/index.js** — Node.js bridge: HyperDHT + Hyperswarm + blind-pairing
- **bridge/lib/pairing.js** — PairingManager: создание инвайтов, DHT серверы, announce
- **bridge/lib/stdio.js** — JSON stdio протокол (adapter ↔ bridge)
- **bridge/lib/identity.js** — IdentityManager на базе keet-identity-key
- **bridge/lib/room.js** — RoomManager: Hypercore + Hyperswarm replication

## HyperDHT v6.32.0 API

### Основные методы
```
new DHT({ port, keyPair, bootstrap })  — создание DHT ноды
dht.ready()                            — Promise, ждёт готовности
dht.createServer({ relayAddresses })   — сервер для P2P соединений
server.listen(keyPair)                 — слушать на ключе
server.address() → { host, port, publicKey }
server.refresh()                       — переанонсировать
server.relayAddresses                  — массив relay-адресов
dht.connect(remotePublicKey)           — подключиться к пиру
dht.remoteAddress() → { host, port } | null  — внешний адрес
dht.findPeer(publicKey)                — найти пира в DHT
dht.lookup(topic)                      — поиск по теме (32 bytes Buffer)
dht.announce(topic, keyPair, relayAddresses) — анонсировать себя
dht.ping({ host, port })               — STUN: result.to.port = внешний порт
dht.destroy()                          — уничтожить ноду
```

### Свойства
```
dht.firewalled     — boolean, блокирует remoteAddress() если true
dht.host           — внешний IP (getter из _nat.host)
dht.port           — внешний порт (getter из _nat.port)
dht._nat           — NatSampler
dht.io.serverSocket.address() → { host, port }  — локальный порт сервера
dht.io.clientSocket.address() → { host, port }  — локальный порт клиента
dht.nodes.toArray()  — массив известных DHT нод
dht.bootstrapped     — boolean
dht.online           — boolean
```

### NatSampler (nat-sampler)
```
nat.add(host, port)  — добавить голос. ВСЕГДА добавляет пару: (host, port) + (host, 0)
nat.host, nat.port   — getter/setter, majority vote
nat._a, nat._b       — лучшие кандидаты { host, port, hits }
nat._samples         — массив из 32 записей
nat.size, nat._threshold, nat._top
```

**Проблема симметричного NAT:** порт 0 всегда побеждает (большинство голосов за 0).
**Обход:** Object.defineProperty на nat.host/nat.port + заполнение _samples.

## Hyperswarm API

```
new Hyperswarm({ keyPair, dht })       — создание swarm
swarm.join(topic, { server, client })  — присоединиться к теме (32 bytes Buffer)
discovery.flushed()                    — ждать полного анонса
swarm.leave(topic)                     — покинуть тему
swarm.flush()                          — ждать завершения DHT операций
swarm.on('connection', (socket, peerInfo)) — новое соединение
swarm.joinPeer(noisePublicKey)         — прямое подключение
swarm.suspend() / swarm.resume()       — пауза/возобновление
```

Роли: **server** — принимает входящие, анонсирует в DHT. **client** — ищет серверы.

## blind-pairing-core API

```
createInvite(key) → { invite, publicKey, seed, discoveryKey }
decodeInvite(invite) → { discoveryKey, seed }
MemberRequest.from(data) — парсинг запроса от кандидата
req.open(publicKey) → userData — расшифровать
req.confirm({ key, encryptionKey }) — принять
req.deny() — отклонить
req.response — буфер ответа (после confirm/deny)
```

## Keet invite format

- 99 байт: 66 (base invite) + 33 (extension: 0x94 + 32 байта encKey)
- flags = 97 (0x61)
- URL: `keet://chat/<z32-encoded-99-bytes>`

## Проблема симметричного NAT

**Симптомы:**
- `dht.remoteAddress()` возвращает `null`
- `dht.port` = 0, `dht.firewalled` = true
- Локальный порт сервера ≠ внешний порт (NAT транслирует)
- STUN-порт меняется при каждом запуске

**Текущее решение (неполное):**
- STUN ping к bootstrap для определения внешнего порта
- Патч NatSampler через Object.defineProperty
- Установка firewalled = false

**Требуется пересмотр архитектуры:**
- Port forwarding на роутере
- UPnP для автоматического проброса
- Relay-ноды вместо прямого DHT
- Hyperswarm holepunching

## Ключевые файлы для модификации

- `bridge/index.js` — старт, DHT настройка, NAT обход, запуск серверов
- `bridge/lib/pairing.js` — создание инвайтов, DHT серверы для invite ключей
- `bridge/lib/stdio.js` — обработчик команд (create_invite, accept_pairing и т.д.)
- `adapter.py` — spawn bridge, stdio протокол, обработка событий
