# t34 — домашняя автоматика на Wiren Board 7

Репозиторий хранит исходники wb-rules (Duktape / ECMAScript 5), конфигурации
mosquitto и MCP-агента для двухконтроллерной системы умного дома.

## Контроллеры и сеть

| IP              | Роль          | Зона ответственности                | Прошивка MTD       |
|-----------------|---------------|-------------------------------------|--------------------|
| `192.168.0.200` | главный       | 2 этаж + лестница, мастер-функции   | `Presence Status` (CamelCase) |
| `192.168.0.189` | вторичный     | 1 этаж                              | `presence_status` (lowercase) |

Часовой пояс: Asia/Vladivostok (UTC+10, без DST). Во всех скриптах
`TZ_OFFSET_HOURS = 10`.

### MQTT-bridge

`mosquitto/bridge-189.conf` деплоится на `.200` в
`/etc/mosquitto/conf.d/bridge-189.conf`. Прокидывает с `.189` на `.200`:
- `mtdx62-mb_24/#` (радар Гостевой) — нужен `climate/guest-ac.js`
- `mtdx62-mb_28/#` (радар санузла 1 эт.) — нужен `ventilation/bath1-dampers.js`
- `wb-mcm8_119/#` (датчик протока) — нужен `ventilation/bath1-dampers.js`

И в обратную сторону `t34-master/controls/last_off` (`.200` → `.189`) для
синхронизации мастер-выключателя.

После правки конфига: `systemctl restart mosquitto`.

## Карта скриптов и куда деплоить

| Файл в репо                                  | Деплой на контроллере                                | Назначение |
|----------------------------------------------|------------------------------------------------------|------------|
| `lights/auto-lights-lib.js`                  | `.200` `/etc/wb-rules/`                              | Общая фабрика автосвета (фактор зависимостей PIR/радар/lux/звук) |
| `lights/auto-lights-ctrl1.js`                | `.200` `/etc/wb-rules/`                              | Автосвет 2 эт. + лестница (использует lib) |
| `lights/auto-lights-ctrl2.js`                | `.189` `/etc/wb-rules/`                              | Автосвет 1 эт. (использует lib) |
| `lights/master-switch.js`                    | `.200` `/etc/wb-rules/`                              | Мастер-выключатель: гасит реле `.200`, инкрементит `t34-master/last_off` |
| `192.168.1.189/master-switch-2.js`           | `.189` `/etc/wb-rules/`                              | Слушает `t34-master/last_off`, гасит реле `.189` |
| `lights/t34-lights.js`                       | `.200` `/etc/wb-rules/`                              | Привязка GPIO/wb-mr6cv3 клавиш к реле `.200` (toggle и scene) |
| `192.168.1.189/t34-lights-2.js`              | `.189` `/etc/wb-rules/`                              | То же для реле `.189` |
| `climate/guest-ac.js`                        | `.200` `/etc/wb-rules/`                              | Кондиционер Centek CT-65K07 в Гостевой через ИК WB-MSW (см. `climate/README.md`) |
| `doors/wb-rules/doors_telegram.js`           | `.200` `/etc/wb-rules/`                              | Виртуальное устройство `doors` + Telegram-уведомления + лог |
| `doors/wb-rules-modules/doors.conf`          | `.200` `/etc/wb-rules-modules/`                      | Список герконов, токены TG, права на оповещения |
| `bin/send_tg.sh`                             | `.200` `/usr/local/bin/t34_send_tg.sh`               | Единая curl-обёртка для Telegram Bot API (используется doors, garage, gate-control, climate, ventilation) |
| `garage/wb-rules/garage.js`                  | `.200` `/etc/wb-rules/`                              | Гараж: автосвет, two-slot car detection (CO₂ + LiDAR), наружные светильники по астрономическим часам |
| `garage/wb-rules/gate-control.js`            | `.200` `/etc/wb-rules/`                              | Управление двумя гаражными воротами + светильниками над ними, авто-закрытие, TG-уведомления |
| `garage/wb-rules-modules/devices.conf`       | `.200` `/etc/wb-rules-modules/`                      | Аппаратная карта гаража + глобальные таймеры/пороги |
| `garage/wb-rules-modules/garage_secrets.js`  | `.200` `/etc/wb-rules-modules/`                      | TG-токен/chat для `gate-control.js` (gitignored) |
| `garage/engine_start/engine_detector.js`     | `.200` `/etc/wb-rules/`                              | Детектор запуска двигателя (CDS: CO₂+VOC+Sound+Temp + быстрый цикл MDT/Sound) |
| `ventilation/bath1-dampers.js`               | `.200` `/etc/wb-rules/`                              | Заслонки санузла 1 эт. (4× WB-MRM2-mini): влажность, проток, VOC; синхронизация чердачной заслонки |
| `ventilation/history-log.js`                 | `.200` `/etc/wb-rules/`                              | Логирование изменений топиков заслонок и HVD-16 для отладки |
| `mosquitto/bridge-189.conf`                  | `.200` `/etc/mosquitto/conf.d/`                      | См. раздел про bridge выше |
| `mcp/wb7_house_agent.py`                     | host (Python)                                        | MCP-сервер: HTTP+MQTT прокси к обоим WB7 для LLM-агентов |
| `damper_actuators/tmp/wb-mqtt-serial.conf`   | rev-инженерный снимок                                | Не деплоится; референс настроек serial-устройств |
| `doors/tmp/wb-mqtt-serial.conf`              | rev-инженерный снимок                                | То же |

## Конвенции

### Структура wb-rules файла
- Весь код оборачивается в IIFE (`(function () { ... })()`) — `wb-rules`
  автозагружает все `.js` из `/etc/wb-rules/` и без IIFE переменные текут
  между файлами при hot-reload.
- Конфиги — JSON с `//` комментариями, читаются `readConfig()`. Первое, что
  делает скрипт: try/catch вокруг `readConfig` и `log.error` + `return` при
  отказе.
- ES5 only (Duktape). Нет `let/const`, стрелочных функций, `Object.assign`.

### Топики
- Реле: `wb-mr6cu_<id>/K<n>` или `wb-mr6cv3_<id>/K<n>`.
- Дискретные входы: `wb-mcm8_<id>/Input <n>` (с пробелом!), `wb-gpio/EXT<n>_IN<m>`,
  `wb-mio-gpio_<id>:1/IN<n>`.
- Датчики WB-MSW: каналы `Temperature`, `Humidity`, `Illuminance`, `Sound Level`,
  `Current Motion`, `Learn to ROM<n>`, `Play from ROM<n>`.
- Радары MTD-262 / MTDX62-MB: `Presence Status` / `Illuminance status` на `.200`,
  `presence_status` / `illuminance` на `.189` — **не путать**, регистр разный
  из-за версий прошивки.
- Виртуальные устройства: `defineVirtualDevice("<vdev>", { cells: ... })`.
  В коде обращение через `dev["<vdev>/<cell>"]` или `dev["<vdev>"]["<cell>"]`.

### Идентификаторы зон
Кириллические сокращения по этажу+функции: `1П` прихожая, `1К` кухня,
`1КБ` большой коридор, `1КМ` малый коридор, `1Г` гостиная, `1ГС` гостевая,
`1ГД` гардероб 1 эт., `1Т` техкомната, `1СА` санузел 1 эт., `1ГР` гараж,
`2С` спальня, `2ДБ`/`2ДМ` детские, `2СД`/`2СБ` санузлы 2 эт., `Л` лестница.

### Защиты
- **Гистерезис** для всех порогов (`luxOn`/`luxOff`, `humHigh`/`humLow`,
  `target ± hyst`).
- **Cooldown** между импульсами на привод (`MOTOR_COOLDOWN_MS`,
  `COMPRESSOR_COOLDOWN_MS`, `DAMPER_COOLDOWN_MS` — 1.5–5 c).
- **Sensor staleness**: если датчик молчит дольше `SENSOR_STALE_MS` —
  принудительный безопасный режим (OFF / закрыто).
- **Стартовая блокировка** (`INIT_GUARD_MS`): первые 1–2 c после загрузки
  игнорируем входы, иначе фантомные срабатывания.
- **Max-on hard cap**: абсолютный потолок наработки (`maxOnHours`,
  `BATH_MAX_ON_MS`) на случай зависших датчиков.

### Telegram
Один скрипт `bin/send_tg.sh` (curl POST `sendMessage`) деплоится на WB как
`/usr/local/bin/t34_send_tg.sh` и используется всеми wb-rules скриптами,
шлющими TG: `doors_telegram.js`, `garage.js`, `gate-control.js`,
`climate/guest-ac.js`, `ventilation/bath1-dampers.js`. Путь зашит в
`devices.conf` (`telegram.scriptPath`), `doors.conf` (`telegram.send_script`)
и константой `TG_SCRIPT` в JS-скриптах.

Секреты держать в `garage_secrets.js` (gitignored) или в `doors.conf`.

## Что НЕ автоматизировано

- В `damper_actuators/` пока только `tmp/wb-mqtt-serial.conf`-снимок —
  скрипт управления приводами заслонок ещё не написан.
- В `ventilation/bath1-dampers.js` есть TODO: датчики влажности/VOC указаны
  как `wb-msw-v3_XXX` — реальный WB-MSW в ванной 1 эт. ещё не установлен.
- Папки `*/tmp/` — временные эталоны конфигов, не часть рабочей системы.
