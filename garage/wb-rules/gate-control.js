// gate-control.js — Управление воротами гаража
//
// Ворота (мотор — импульс запускает/останавливает привод):
//   Левые:  wb-mr6cv3_119/K3   Правые: wb-mr6cv3_119/K6
// Светильники над воротами:
//   Левые:  wb-mr6cu_43/K4    Правые: wb-mr6cu_43/K5
// Концевики (Normally Open: 0 = открыты, 1 = закрыты):
//   Левые:  wb-mcm8_94/Input 1   Правые: wb-mcm8_94/Input 2
// Датчики освещённости: wb-msw-v4_36, _110, mtdx62-mb_30, _34

(function () {

// ══════════════════════════════════════════════════════════════════
// АППАРАТНЫЕ КОНСТАНТЫ
// ══════════════════════════════════════════════════════════════════

var SIDES = ["left", "right"];

var HW = {
  left: {
    motor: "wb-mr6cv3_119/K3",
    light: "wb-mr6cu_43/K4",
    reed:  "wb-mcm8_94/Input 1",
    label: "Левые",
  },
  right: {
    motor: "wb-mr6cv3_119/K6",
    light: "wb-mr6cu_43/K5",
    reed:  "wb-mcm8_94/Input 2",
    label: "Правые",
  },
};

var LUX_TOPICS = [
  "wb-msw-v4_36/Illuminance",
  "wb-msw-v4_110/Illuminance",
  "mtdx62-mb_30/Illuminance status",
  "mtdx62-mb_34/Illuminance status",
];

// ══════════════════════════════════════════════════════════════════
// НАСТРОЙКИ
// ══════════════════════════════════════════════════════════════════

var TZ_OFFSET_HOURS         = 10;       // Asia/Vladivostok = UTC+10 (без DST)
var PULSE_MS                = 500;      // длительность импульса мотора
var MOTOR_COOLDOWN_MS       = 1500;     // блокировка повторного импульса
var SYNC_RETRY_MS           = 2000;     // повторная синхронизация после старта
var AUTO_CLOSE_MIN_DEF      = 5;
var LIGHT_OFF_DELAY_MIN_DEF = 2;
var LUX_THRESHOLD_DEF       = 50;
var LUX_MIN_DELTA           = 0.5;      // публиковать lux только при дельте ≥ 0.5

var TG_SCRIPT = "/usr/local/bin/t34_send_tg.sh";
// Секреты загружаются из /etc/wb-rules-modules/garage_secrets.js (игнорируется git).
var TG_TOKEN = "";
var TG_CHAT  = "";
try {
  var _s = require("garage_secrets");
  if (_s && _s.tgToken) TG_TOKEN = _s.tgToken;
  if (_s && _s.tgChat)  TG_CHAT  = _s.tgChat;
} catch (e) {
  log.warning("[ВОРОТА] garage_secrets не найден — Telegram отключён");
}

var VDEV = "garage_gates";

// ══════════════════════════════════════════════════════════════════
// СОСТОЯНИЕ
// ══════════════════════════════════════════════════════════════════

function makeGateState() {
  return {
    closed:         true,
    lightCached:    false,
    lightAutoOn:    false,
    lightManualOn:  false,
    lightManualOff: false,
    lightOffTimer:  null,
    autoCloseTimer: null,
    autoCloseAt:    0,
    motorBusyUntil: 0,
  };
}

var gs = { left: makeGateState(), right: makeGateState() };
var luxLastPublished = -1;

// ══════════════════════════════════════════════════════════════════
// УТИЛИТЫ
// ══════════════════════════════════════════════════════════════════

function ts() {
  // Локальное время Asia/Vladivostok (UTC+10, без DST)
  var d = new Date(Date.now() + TZ_OFFSET_HOURS * 3600000);
  return d.toISOString().replace("T", " ").slice(0, 19);
}

function shellQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

function getLux() {
  var sum = 0, count = 0, v, i;
  for (i = 0; i < LUX_TOPICS.length; i++) {
    v = dev[LUX_TOPICS[i]];
    if (v !== undefined && v !== null) { sum += Number(v); count++; }
  }
  return count > 0 ? sum / count : null;
}

function refreshLux() {
  var lux = getLux();
  if (lux === null) {
    if (luxLastPublished !== -1) {
      dev[VDEV + "/lux"] = -1;
      luxLastPublished = -1;
    }
    return null;
  }
  if (luxLastPublished < 0 || Math.abs(lux - luxLastPublished) >= LUX_MIN_DELTA) {
    dev[VDEV + "/lux"] = Math.round(lux * 10) / 10;
    luxLastPublished = lux;
  }
  return lux;
}

function luxThreshold() {
  var t = Number(dev[VDEV + "/lux_threshold"]);
  return (isNaN(t) || t <= 0) ? LUX_THRESHOLD_DEF : t;
}

function lightOffDelayMs() {
  var m = Number(dev[VDEV + "/light_off_delay_min"]);
  if (isNaN(m) || m < 0) m = LIGHT_OFF_DELAY_MIN_DEF;
  return m * 60000;
}

function tgSend(text) {
  if (!TG_TOKEN || !TG_CHAT) return;
  // Текст идёт через stdin → переменную MSG, никакой шелл-интерполяции
  var cmd = "MSG=$(cat); bash " + shellQuote(TG_SCRIPT)
          + " " + shellQuote(TG_TOKEN)
          + " " + shellQuote(TG_CHAT)
          + " \"$MSG\" >/dev/null 2>&1";
  runShellCommand(cmd, { input: text, captureOutput: false });
}

function logEvent(msg) {
  log.info("[ВОРОТА] " + msg);
  dev[VDEV + "/last_event"] = ts() + " — " + msg;
}

// ══════════════════════════════════════════════════════════════════
// СВЕТ
// ══════════════════════════════════════════════════════════════════

function markManual(st, on) {
  if (on) {
    st.lightManualOn  = true;
    st.lightManualOff = false;
  } else {
    st.lightManualOn  = false;
    st.lightManualOff = true;
    st.lightAutoOn    = false;
  }
  if (st.lightOffTimer) {
    clearTimeout(st.lightOffTimer);
    st.lightOffTimer = null;
  }
}

// Скриптовое (автоматическое) переключение света
function setLight(side, on, reason) {
  var h  = HW[side];
  var st = gs[side];
  if (st.lightCached === on) return;
  // обновляем кэш ДО записей, чтобы watcher'ы реле/UI приняли это за эхо
  st.lightCached = on;
  dev[h.light]                       = on;
  dev[VDEV + "/" + side + "_light"]  = on;
  st.lightAutoOn = on;
  log.info("[ВОРОТА] " + side + " свет: " + (on ? "ВКЛ" : "ВЫКЛ") + " (" + reason + ")");
}

// Внешнее изменение света: source = "ui" (vdev switch) или "relay" (физическое реле)
function onLightExternal(side, raw, source) {
  var on = (raw === true || raw === 1);
  var st = gs[side];
  if (on === st.lightCached) return; // эхо собственной записи

  st.lightCached = on;
  if (source === "ui") dev[HW[side].light]              = on;
  else                 dev[VDEV + "/" + side + "_light"] = on;
  markManual(st, on);
  log.info("[ВОРОТА] " + side + " свет: " + source + " " + (on ? "ВКЛ" : "ВЫКЛ") + " (ручн.)");
}

// ══════════════════════════════════════════════════════════════════
// МОТОР
// ══════════════════════════════════════════════════════════════════

function pulseGate(side, reason) {
  var h   = HW[side];
  var st  = gs[side];
  var now = Date.now();
  if (now < st.motorBusyUntil) {
    log.info("[ВОРОТА] " + h.label + ": импульс проигнорирован (cooldown), " + reason);
    return false;
  }
  st.motorBusyUntil = now + PULSE_MS + MOTOR_COOLDOWN_MS;
  dev[h.motor] = true;
  setTimeout(function () { dev[h.motor] = false; }, PULSE_MS);
  log.info("[ВОРОТА] " + h.label + ": импульс мотора (" + reason + ")");
  return true;
}

// ══════════════════════════════════════════════════════════════════
// АВТОЗАКРЫТИЕ
// ══════════════════════════════════════════════════════════════════

function updateCountdown(side) {
  var st   = gs[side];
  var cell = VDEV + "/" + side + "_close_in";
  if (st.autoCloseAt > 0) {
    var rem = Math.max(0, Math.ceil((st.autoCloseAt - Date.now()) / 60000));
    dev[cell] = rem > 0 ? "через " + rem + " мин" : "скоро...";
  } else {
    dev[cell] = "";
  }
}

function cancelAutoClose(side) {
  var st = gs[side];
  if (st.autoCloseTimer) { clearTimeout(st.autoCloseTimer); st.autoCloseTimer = null; }
  st.autoCloseAt = 0;
  updateCountdown(side);
}

function startAutoClose(side) {
  var enabled = dev[VDEV + "/auto_close_on"];
  if (enabled === false || enabled === 0) return;
  cancelAutoClose(side);

  var minutes = Number(dev[VDEV + "/auto_close_min"]);
  if (isNaN(minutes) || minutes <= 0) minutes = AUTO_CLOSE_MIN_DEF;
  var ms = minutes * 60000;
  var st = gs[side];
  st.autoCloseAt = Date.now() + ms;
  updateCountdown(side);

  st.autoCloseTimer = setTimeout(function () {
    st.autoCloseTimer = null;
    st.autoCloseAt    = 0;
    updateCountdown(side);
    if (st.closed) return;
    var msg = HW[side].label + " ворота: автозакрытие (открыты " + minutes + " мин)";
    logEvent(msg);
    tgSend("[ВОРОТА] " + msg + "\nВремя: " + ts());
    pulseGate(side, "автозакрытие через " + minutes + " мин");
  }, ms);
}

// ══════════════════════════════════════════════════════════════════
// ИЗМЕНЕНИЕ СОСТОЯНИЯ ВОРОТ
// ══════════════════════════════════════════════════════════════════

function onGateChange(side, rawVal) {
  var nowClosed = (rawVal === true || rawVal === 1);
  var st        = gs[side];
  if (nowClosed === st.closed) return;
  st.closed = nowClosed;

  var label     = HW[side].label;
  var stateText = nowClosed ? "ЗАКРЫТЫ" : "ОТКРЫТЫ";
  dev[VDEV + "/" + side + "_state"] = nowClosed ? "Закрыты" : "Открыты";

  if (!nowClosed) {
    // Ворота открылись
    var lux    = refreshLux();
    var luxStr = (lux === null) ? "n/a" : lux.toFixed(1);
    var dark   = (lux !== null) && (lux < luxThreshold());

    logEvent(label + " ворота: " + stateText + "  [лк=" + luxStr + "]");
    tgSend("[ВОРОТА] " + label + " ворота: " + stateText +
           "\nОсвещённость: " + luxStr + " лк\nВремя: " + ts());

    if (dark && !st.lightManualOff) {
      if (st.lightOffTimer) { clearTimeout(st.lightOffTimer); st.lightOffTimer = null; }
      setLight(side, true, "ворота открылись, темно (" + luxStr + " лк)");
    }

    startAutoClose(side);

  } else {
    // Ворота закрылись
    logEvent(label + " ворота: " + stateText);
    tgSend("[ВОРОТА] " + label + " ворота: " + stateText + "\nВремя: " + ts());

    cancelAutoClose(side);

    if (st.lightAutoOn && !st.lightManualOn) {
      if (st.lightOffTimer) clearTimeout(st.lightOffTimer);
      st.lightOffTimer = setTimeout(function () {
        st.lightOffTimer = null;
        if (st.lightManualOn) return;
        setLight(side, false, "ворота закрыты, таймер выкл");
      }, lightOffDelayMs());
    }

    st.lightManualOff = false;
  }
}

// ══════════════════════════════════════════════════════════════════
// ВИРТУАЛЬНОЕ УСТРОЙСТВО
// ══════════════════════════════════════════════════════════════════

defineVirtualDevice(VDEV, {
  title: "Гараж — Ворота",
  cells: {
    left_state:          { type: "text",       value: "неизвестно",            title: "Левые ворота: состояние"          },
    right_state:         { type: "text",       value: "неизвестно",            title: "Правые ворота: состояние"         },

    cmd_left:            { type: "pushbutton",                                  title: "Левые: открыть / закрыть"         },
    cmd_right:           { type: "pushbutton",                                  title: "Правые: открыть / закрыть"        },
    cmd_close_all:       { type: "pushbutton",                                  title: "Закрыть ВСЕ ворота"               },

    left_light:          { type: "switch",     value: false,                    title: "Левые: свет"                      },
    right_light:         { type: "switch",     value: false,                    title: "Правые: свет"                     },
    lux:                 { type: "value",      value: 0,                        title: "Освещённость ср., лк"             },
    lux_threshold:       { type: "range",      value: LUX_THRESHOLD_DEF,
                           min: 5, max: 300,                                    title: "Порог 'темно', лк"                },
    light_off_delay_min: { type: "range",      value: LIGHT_OFF_DELAY_MIN_DEF,
                           min: 0, max: 30,                                     title: "Авто-выкл света: задержка (мин)"  },

    auto_close_on:       { type: "switch",     value: true,                     title: "Автозакрытие: вкл"                },
    auto_close_min:      { type: "range",      value: AUTO_CLOSE_MIN_DEF,
                           min: 1, max: 120,                                    title: "Автозакрытие: через (мин)"        },
    left_close_in:       { type: "text",       value: "",                       title: "Левые: закроются"                 },
    right_close_in:      { type: "text",       value: "",                       title: "Правые: закроются"                },

    last_event:          { type: "text",       value: "",                       title: "Последнее событие"                },
  },
});

// ══════════════════════════════════════════════════════════════════
// ИНИЦИАЛИЗАЦИЯ
// ══════════════════════════════════════════════════════════════════

function syncStartup() {
  SIDES.forEach(function (side) {
    var h  = HW[side];
    var st = gs[side];

    var rv = dev[h.reed];
    if (rv !== undefined && rv !== null) {
      st.closed = (rv === true || rv === 1);
      dev[VDEV + "/" + side + "_state"] = st.closed ? "Закрыты" : "Открыты";
    }

    var lv = dev[h.light];
    if (lv !== undefined && lv !== null) {
      st.lightCached = (lv === true || lv === 1);
      dev[VDEV + "/" + side + "_light"] = st.lightCached;
    }

    log.info("[ВОРОТА] init " + side +
      ": " + (st.closed ? "закрыты" : "открыты") +
      ", свет=" + (st.lightCached ? "вкл" : "выкл"));
  });
  refreshLux();
}

// Сбрасываем моторы — на случай если предыдущий запуск завис в импульсе
SIDES.forEach(function (side) { dev[HW[side].motor] = false; });
syncStartup();
// Повтор: retained MQTT-значения могут прийти с задержкой
setTimeout(syncStartup, SYNC_RETRY_MS);

// ══════════════════════════════════════════════════════════════════
// ПРАВИЛА
// ══════════════════════════════════════════════════════════════════

SIDES.forEach(function (side) {
  var h     = HW[side];
  var label = h.label;

  defineRule("gg_" + side + "_reed", {
    whenChanged: h.reed,
    then: function (v) { onGateChange(side, v); },
  });

  defineRule("gg_cmd_" + side, {
    whenChanged: VDEV + "/cmd_" + side,
    then: function () {
      var action = gs[side].closed ? "открытие" : "закрытие";
      if (pulseGate(side, "кнопка (" + action + ")")) {
        logEvent(label + " ворота: команда " + action + " (кнопка)");
      }
    },
  });

  defineRule("gg_" + side + "_light_sw", {
    whenChanged: VDEV + "/" + side + "_light",
    then: function (v) { onLightExternal(side, v, "ui"); },
  });

  defineRule("gg_" + side + "_light_relay", {
    whenChanged: h.light,
    then: function (v) { onLightExternal(side, v, "relay"); },
  });
});

defineRule("gg_cmd_close_all", {
  whenChanged: VDEV + "/cmd_close_all",
  then: function () {
    var sent = false;
    SIDES.forEach(function (side) {
      if (!gs[side].closed && pulseGate(side, "закрыть все")) sent = true;
    });
    if (sent) {
      logEvent("Команда: закрыть все ворота");
      tgSend("[ВОРОТА] Принудительное закрытие всех ворот\nВремя: " + ts());
    } else {
      logEvent("Закрыть все: ворота уже закрыты");
    }
  },
});

defineRule("gg_auto_close_toggle", {
  whenChanged: VDEV + "/auto_close_on",
  then: function (v) {
    var en = (v === true || v === 1);
    log.info("[ВОРОТА] автозакрытие: " + (en ? "включено" : "выключено"));
    SIDES.forEach(function (side) {
      if (!en) cancelAutoClose(side);
      else if (!gs[side].closed) startAutoClose(side);
    });
  },
});

defineRule("gg_auto_close_min", {
  whenChanged: VDEV + "/auto_close_min",
  then: function () {
    var en = dev[VDEV + "/auto_close_on"];
    if (en === false || en === 0) return;
    SIDES.forEach(function (side) {
      if (!gs[side].closed) startAutoClose(side);
    });
  },
});

defineRule("gg_lux_refresh", {
  whenChanged: LUX_TOPICS,
  then: refreshLux,
});

log.info("[ВОРОТА] Скрипт загружен. Левые=" + (gs.left.closed ? "закрыты" : "открыты") +
  "  Правые=" + (gs.right.closed ? "закрыты" : "открыты"));

})();
