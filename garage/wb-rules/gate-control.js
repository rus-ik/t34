// gate-control.js — Управление воротами гаража
//
// Ворота (мотор — импульс запускает/останавливает привод):
//   Левые:  wb-mr6cv3_119/K3   Правые: wb-mr6cv3_119/K6
//
// Светильники над воротами:
//   Левые:  wb-mr6cu_43/K4
//   Правые: wb-mr6cu_43/K5
//
// Концевики (wb-mcm8_94, Normally Open: 0 = ворота открыты, 1 = закрыты):
//   Левые:  Input 1   Правые: Input 2
//
// Датчики освещённости:
//   wb-msw-v4_36/Illuminance, wb-msw-v4_110/Illuminance
//   mtdx62-mb_30/Illuminance status, mtdx62-mb_34/Illuminance status

(function () {

// ══════════════════════════════════════════════════════════════════
// АППАРАТНЫЕ КОНСТАНТЫ
// ══════════════════════════════════════════════════════════════════

var MOTOR_LEFT  = "wb-mr6cv3_119/K3";
var MOTOR_RIGHT = "wb-mr6cv3_119/K6";

var LIGHT_LEFT  = "wb-mr6cu_43/K4";
var LIGHT_RIGHT = "wb-mr6cu_43/K5";

// Normally Open: 0 = ворота открыты, 1 = ворота закрыты
var REED_LEFT  = "wb-mcm8_94/Input 1";
var REED_RIGHT = "wb-mcm8_94/Input 2";

var LUX_TOPICS = [
  "wb-msw-v4_36/Illuminance",
  "wb-msw-v4_110/Illuminance",
  "mtdx62-mb_30/Illuminance status",
  "mtdx62-mb_34/Illuminance status",
];

// ══════════════════════════════════════════════════════════════════
// НАСТРОЙКИ
// ══════════════════════════════════════════════════════════════════

var PULSE_MS           = 500;            // длительность импульса мотора, мс
var AUTO_CLOSE_MIN_DEF = 5;              // авtozакрытие по умолчанию, мин
var LUX_THRESHOLD_DEF  = 50;            // порог «темно», лк
var LIGHT_OFF_DELAY_MS = 2 * 60 * 1000; // задержка выкл света после закрытия

var TG_SCRIPT = "/usr/local/bin/t34_send_tg.sh";
var TG_TOKEN  = "7042371125:AAGoHru0YWW9l4vihJPYP72DIAtq6PkzcqE";
var TG_CHAT   = "2006469967";

var VDEV = "garage_gates";

// ══════════════════════════════════════════════════════════════════
// СОСТОЯНИЕ
// ══════════════════════════════════════════════════════════════════

function makeGateState() {
  return {
    closed:         true,   // true = закрыты (reed=1)
    lightCached:    false,  // последнее значение, записанное скриптом в реле
    lightAutoOn:    false,  // свет включён автоматически (не вручную)
    lightManualOn:  false,  // пользователь вручную включил
    lightManualOff: false,  // пользователь вручную выключил
    lightOffTimer:  null,
    autoCloseTimer: null,
    autoCloseAt:    0,      // ms timestamp окончания таймера
  };
}

var gs = { left: makeGateState(), right: makeGateState() };

// ══════════════════════════════════════════════════════════════════
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ══════════════════════════════════════════════════════════════════

function ts() {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

function getLux() {
  var sum = 0, count = 0, v, i;
  for (i = 0; i < LUX_TOPICS.length; i++) {
    v = dev[LUX_TOPICS[i]];
    if (v !== undefined && v !== null) { sum += Number(v); count++; }
  }
  return count > 0 ? sum / count : 9999;
}

function refreshLux() {
  var lux = getLux();
  dev[VDEV + "/lux"] = Math.round(lux * 10) / 10;
  return lux;
}

function luxThreshold() {
  var t = Number(dev[VDEV + "/lux_threshold"]);
  return (isNaN(t) || t <= 0) ? LUX_THRESHOLD_DEF : t;
}

function tgSend(text) {
  if (!TG_TOKEN || !TG_CHAT) return;
  var esc = text
    .replace(/\\/g, "\\\\")
    .replace(/'/g,  "\\'")
    .replace(/\n/g, "\\n");
  runShellCommand(
    "bash '" + TG_SCRIPT + "' '" + TG_TOKEN + "' '" + TG_CHAT + "' $'" + esc + "' >/dev/null 2>&1 &"
  );
}

function logEvent(msg) {
  log.info("[ВОРОТА] " + msg);
  dev[VDEV + "/last_event"] = ts() + " — " + msg;
}

function gateLabel(side)  { return side === "left" ? "Левые"      : "Правые";     }
function lightTopic(side) { return side === "left" ? LIGHT_LEFT   : LIGHT_RIGHT;  }

// ── Управление светом ─────────────────────────────────────────────────────────
//
// Детекция ручного вмешательства: сравниваем st.lightCached (что скрипт последний
// раз записал в реле) с фактическим состоянием реле. Расхождение = внешнее изменение.

function setLight(side, on, reason) {
  var st    = gs[side];
  var topic = lightTopic(side);
  var vcell = VDEV + "/" + side + "_light";

  // Проверка внешнего (ручного) изменения
  var raw    = dev[topic];
  var actual = (raw === true || raw === 1);
  if (actual !== st.lightCached) {
    st.lightCached = actual;
    dev[vcell]     = actual;
    if (actual) {
      st.lightManualOn = true; st.lightManualOff = false;
    } else {
      st.lightManualOff = true; st.lightManualOn = false; st.lightAutoOn = false;
    }
    log.info("[ВОРОТА] " + side + " свет: внешнее " + (actual ? "ВКЛ" : "ВЫКЛ") + " обнаружено");
    return; // всегда уважаем ручное вмешательство
  }

  if (st.lightCached === on) return; // уже в нужном состоянии

  st.lightCached = on; // обновляем кэш ДО записи в dev, чтобы watchers не приняли за ручное
  dev[topic]     = on;
  dev[vcell]     = on;
  st.lightAutoOn = on;
  log.info("[ВОРОТА] " + side + " свет: " + (on ? "ВКЛ" : "ВЫКЛ") + " (" + reason + ")");
}

// ── Импульс мотора ────────────────────────────────────────────────────────────

function pulseGate(side, reason) {
  var topic = (side === "left") ? MOTOR_LEFT : MOTOR_RIGHT;
  dev[topic] = true;
  setTimeout(function () { dev[topic] = false; }, PULSE_MS);
  log.info("[ВОРОТА] " + gateLabel(side) + ": импульс мотора (" + reason + ")");
}

// ── Авtozакрытие ──────────────────────────────────────────────────────────────

function cancelAutoClose(side) {
  var st = gs[side];
  if (st.autoCloseTimer) { clearTimeout(st.autoCloseTimer); st.autoCloseTimer = null; }
  st.autoCloseAt = 0;
  dev[VDEV + "/" + side + "_close_in"] = "";
}

function startAutoClose(side) {
  var enabled = dev[VDEV + "/auto_close_on"];
  if (enabled === false || enabled === 0) return;
  cancelAutoClose(side);

  var minutes = Number(dev[VDEV + "/auto_close_min"]);
  if (isNaN(minutes) || minutes <= 0) minutes = AUTO_CLOSE_MIN_DEF;
  var ms = minutes * 60 * 1000;
  var st = gs[side];
  st.autoCloseAt = Date.now() + ms;

  st.autoCloseTimer = setTimeout(function () {
    st.autoCloseTimer = null;
    st.autoCloseAt    = 0;
    dev[VDEV + "/" + side + "_close_in"] = "";
    if (st.closed) return; // уже закрыты вручную — ничего не делаем
    var msg = gateLabel(side) + " ворота: авtoзакрытие (открыты " + minutes + " мин)";
    logEvent(msg);
    tgSend("[ВОРОТА] " + msg + "\nВремя: " + ts());
    pulseGate(side, "авtoзакрытие через " + minutes + " мин");
  }, ms);
}

function updateCountdown() {
  var now   = Date.now();
  var sides = ["left", "right"];
  for (var i = 0; i < sides.length; i++) {
    var s    = sides[i];
    var st   = gs[s];
    var cell = VDEV + "/" + s + "_close_in";
    if (st.autoCloseAt > 0) {
      var rem = Math.max(0, Math.ceil((st.autoCloseAt - now) / 60000));
      dev[cell] = rem > 0 ? "через " + rem + " мин" : "скоро...";
    } else {
      dev[cell] = "";
    }
  }
}

// ══════════════════════════════════════════════════════════════════
// ЛОГИКА ИЗМЕНЕНИЯ СОСТОЯНИЯ ВОРОТ
// ══════════════════════════════════════════════════════════════════

function onGateChange(side, rawVal) {
  var nowClosed = (rawVal === true || rawVal === 1);
  var st        = gs[side];
  if (nowClosed === st.closed) return;
  st.closed = nowClosed;

  var label     = gateLabel(side);
  var stateText = nowClosed ? "ЗАКРЫТЫ" : "ОТКРЫТЫ";
  dev[VDEV + "/" + side + "_state"] = nowClosed ? "Закрыты" : "Открыты";

  if (!nowClosed) {
    // ── Ворота открылись ──────────────────────────────────────────
    var lux  = refreshLux();
    var dark = lux < luxThreshold();

    logEvent(label + " ворота: " + stateText + "  [лк=" + lux.toFixed(1) + "]");
    tgSend(
      "[ВОРОТА] " + label + " ворота: " + stateText +
      "\nОсвещённость: " + lux.toFixed(1) + " лк" +
      "\nВремя: " + ts()
    );

    // Авто-свет при открытии: включаем если темно и пользователь не выключал вручную
    if (dark && !st.lightManualOff) {
      if (st.lightOffTimer) { clearTimeout(st.lightOffTimer); st.lightOffTimer = null; }
      setLight(side, true, "ворота открылись, темно (" + lux.toFixed(1) + " лк)");
    }

    startAutoClose(side);

  } else {
    // ── Ворота закрылись ──────────────────────────────────────────
    logEvent(label + " ворота: " + stateText);
    tgSend("[ВОРОТА] " + label + " ворота: " + stateText + "\nВремя: " + ts());

    cancelAutoClose(side);

    // Авто-выкл света: если свет включён автоматически и не переопределён вручную
    if (st.lightAutoOn && !st.lightManualOn) {
      if (st.lightOffTimer) clearTimeout(st.lightOffTimer);
      st.lightOffTimer = setTimeout(function () {
        st.lightOffTimer = null;
        if (st.lightManualOn) return; // пока ждали — вручную включили
        setLight(side, false, "ворота закрыты, таймер выкл");
      }, LIGHT_OFF_DELAY_MS);
    }

    // Сброс флага «вручную выключен» — при следующем открытии авто-логика снова работает
    st.lightManualOff = false;
  }
}

// ══════════════════════════════════════════════════════════════════
// ВИРТУАЛЬНОЕ УСТРОЙСТВО
// ══════════════════════════════════════════════════════════════════

defineVirtualDevice(VDEV, {
  title: "Гараж — Ворота",
  cells: {
    // ── Состояние ворот ─────────────────────────────────────────────
    left_state:     { type: "text",   value: "неизвестно",      title: "Левые ворота: состояние"   },
    right_state:    { type: "text",   value: "неизвестно",      title: "Правые ворота: состояние"  },

    // ── Управление воротами ─────────────────────────────────────────
    cmd_left:       { type: "pushbutton",                        title: "Левые: открыть / закрыть"  },
    cmd_right:      { type: "pushbutton",                        title: "Правые: открыть / закрыть" },
    cmd_close_all:  { type: "pushbutton",                        title: "Закрыть ВСЕ ворота"        },

    // ── Свет над воротами (ручное управление) ──────────────────────
    left_light:     { type: "switch", value: false,              title: "Левые: свет"               },
    right_light:    { type: "switch", value: false,              title: "Правые: свет"              },
    lux:            { type: "value",  value: 0,                  title: "Освещённость ср., лк"      },
    lux_threshold:  { type: "range",  value: LUX_THRESHOLD_DEF,
                      min: 5, max: 300,                          title: "Порог 'темно', лк"         },

    // ── Авtozакрытие ────────────────────────────────────────────────
    auto_close_on:  { type: "switch", value: true,               title: "Авtoзакрытие: вкл"         },
    auto_close_min: { type: "range",  value: AUTO_CLOSE_MIN_DEF,
                      min: 1, max: 120,                          title: "Авtoзакрытие: через (мин)" },
    left_close_in:  { type: "text",   value: "",                 title: "Левые: закроются"          },
    right_close_in: { type: "text",   value: "",                 title: "Правые: закроются"         },

    // ── Журнал событий ──────────────────────────────────────────────
    last_event:     { type: "text",   value: "",                 title: "Последнее событие"         },
  },
});

// ══════════════════════════════════════════════════════════════════
// ИНИЦИАЛИЗАЦИЯ — синхронизация начального состояния
// ══════════════════════════════════════════════════════════════════

(function syncStartup() {
  var cfg = [
    { side: "left",  reed: REED_LEFT,  light: LIGHT_LEFT  },
    { side: "right", reed: REED_RIGHT, light: LIGHT_RIGHT },
  ];
  for (var i = 0; i < cfg.length; i++) {
    var c  = cfg[i];
    var st = gs[c.side];

    var rv     = dev[c.reed];
    st.closed  = (rv === true || rv === 1);
    dev[VDEV + "/" + c.side + "_state"] = st.closed ? "Закрыты" : "Открыты";

    var lv          = dev[c.light];
    st.lightCached  = (lv === true || lv === 1);
    dev[VDEV + "/" + c.side + "_light"] = st.lightCached;

    log.info("[ВОРОТА] init: " + c.side +
      " — " + (st.closed ? "закрыты" : "открыты") +
      ", свет=" + (st.lightCached ? "вкл" : "выкл"));
  }
  refreshLux();
})();

// ══════════════════════════════════════════════════════════════════
// ПРАВИЛА
// ══════════════════════════════════════════════════════════════════

// ── Концевики ворот ───────────────────────────────────────────────
defineRule("gg_left_reed", {
  whenChanged: REED_LEFT,
  then: function (v) { onGateChange("left", v); },
});
defineRule("gg_right_reed", {
  whenChanged: REED_RIGHT,
  then: function (v) { onGateChange("right", v); },
});

// ── Кнопки управления воротами ────────────────────────────────────
defineRule("gg_cmd_left", {
  whenChanged: VDEV + "/cmd_left",
  then: function () {
    var action = gs.left.closed ? "открытие" : "закрытие";
    pulseGate("left", "кнопка (" + action + ")");
    logEvent("Левые ворота: команда " + action + " (кнопка)");
  },
});
defineRule("gg_cmd_right", {
  whenChanged: VDEV + "/cmd_right",
  then: function () {
    var action = gs.right.closed ? "открытие" : "закрытие";
    pulseGate("right", "кнопка (" + action + ")");
    logEvent("Правые ворота: команда " + action + " (кнопка)");
  },
});
defineRule("gg_cmd_close_all", {
  whenChanged: VDEV + "/cmd_close_all",
  then: function () {
    var sent = false;
    if (!gs.left.closed)  { pulseGate("left",  "закрыть все"); sent = true; }
    if (!gs.right.closed) { pulseGate("right", "закрыть все"); sent = true; }
    if (sent) {
      logEvent("Команда: закрыть все ворота");
      tgSend("[ВОРОТА] Принудительное закрытие всех ворот\nВремя: " + ts());
    } else {
      logEvent("Закрыть все: ворота уже закрыты");
    }
  },
});

// ── Ручное управление светом из UI ───────────────────────────────
//
// Пользователь переключил switch на карточке vdev.
// st.lightCached уже равно новому значению если это скрипт переключил (return сразу).

defineRule("gg_left_light_sw", {
  whenChanged: VDEV + "/left_light",
  then: function (v) {
    var on = (v === true || v === 1);
    var st = gs.left;
    if (on === st.lightCached) return; // скрипт сам изменил — игнорируем
    // Ручное управление из UI
    st.lightCached = on;
    dev[LIGHT_LEFT] = on;
    if (on) {
      st.lightManualOn  = true;
      st.lightManualOff = false;
      if (st.lightOffTimer) { clearTimeout(st.lightOffTimer); st.lightOffTimer = null; }
    } else {
      st.lightManualOff = true;
      st.lightManualOn  = false;
      st.lightAutoOn    = false;
      if (st.lightOffTimer) { clearTimeout(st.lightOffTimer); st.lightOffTimer = null; }
    }
    log.info("[ВОРОТА] left свет: UI " + (on ? "ВКЛ" : "ВЫКЛ") + " (ручн.)");
  },
});
defineRule("gg_right_light_sw", {
  whenChanged: VDEV + "/right_light",
  then: function (v) {
    var on = (v === true || v === 1);
    var st = gs.right;
    if (on === st.lightCached) return;
    st.lightCached = on;
    dev[LIGHT_RIGHT] = on;
    if (on) {
      st.lightManualOn  = true;
      st.lightManualOff = false;
      if (st.lightOffTimer) { clearTimeout(st.lightOffTimer); st.lightOffTimer = null; }
    } else {
      st.lightManualOff = true;
      st.lightManualOn  = false;
      st.lightAutoOn    = false;
      if (st.lightOffTimer) { clearTimeout(st.lightOffTimer); st.lightOffTimer = null; }
    }
    log.info("[ВОРОТА] right свет: UI " + (on ? "ВКЛ" : "ВЫКЛ") + " (ручн.)");
  },
});

// ── Физическое изменение реле света (настенный выключатель) ──────
//
// Синхронизирует vdev switch и выставляет флаги ручного вмешательства.
// st.lightCached обновляется ДО записи в dev в setLight(), поэтому
// при автоматическом изменении on === st.lightCached → return.

defineRule("gg_left_light_relay", {
  whenChanged: LIGHT_LEFT,
  then: function (v) {
    var on = (v === true || v === 1);
    var st = gs.left;
    if (on === st.lightCached) return; // script-originated change
    st.lightCached = on;
    dev[VDEV + "/left_light"] = on;
    if (on) { st.lightManualOn  = true;  st.lightManualOff = false; }
    else    { st.lightManualOff = true;  st.lightManualOn  = false; st.lightAutoOn = false; }
    log.info("[ВОРОТА] left свет: физ. выкл. " + (on ? "ВКЛ" : "ВЫКЛ"));
  },
});
defineRule("gg_right_light_relay", {
  whenChanged: LIGHT_RIGHT,
  then: function (v) {
    var on = (v === true || v === 1);
    var st = gs.right;
    if (on === st.lightCached) return;
    st.lightCached = on;
    dev[VDEV + "/right_light"] = on;
    if (on) { st.lightManualOn  = true;  st.lightManualOff = false; }
    else    { st.lightManualOff = true;  st.lightManualOn  = false; st.lightAutoOn = false; }
    log.info("[ВОРОТА] right свет: физ. выкл. " + (on ? "ВКЛ" : "ВЫКЛ"));
  },
});

// ── Авtoзакрытие: вкл/выкл ───────────────────────────────────────
defineRule("gg_auto_close_toggle", {
  whenChanged: VDEV + "/auto_close_on",
  then: function (v) {
    var en = (v === true || v === 1);
    log.info("[ВОРОТА] авtoзакрытие: " + (en ? "включено" : "выключено"));
    if (!en) {
      cancelAutoClose("left");
      cancelAutoClose("right");
    } else {
      if (!gs.left.closed)  startAutoClose("left");
      if (!gs.right.closed) startAutoClose("right");
    }
  },
});

// ── Авtoзакрытие: изменение интервала ────────────────────────────
defineRule("gg_auto_close_min", {
  whenChanged: VDEV + "/auto_close_min",
  then: function () {
    var en = dev[VDEV + "/auto_close_on"];
    if (en === false || en === 0) return;
    // Перезапустить таймеры для открытых ворот с новым интервалом
    if (!gs.left.closed)  startAutoClose("left");
    if (!gs.right.closed) startAutoClose("right");
  },
});

// ── Обратный отсчёт и обновление lux ─────────────────────────────
defineRule("gg_countdown", {
  when: function () { return cron("*/30 * * * * *"); },
  then: updateCountdown,
});
defineRule("gg_lux_refresh", {
  when: function () { return cron("0 * * * * *"); },
  then: refreshLux,
});

log.info("[ВОРОТА] Скрипт загружен. Левые=" + (gs.left.closed ? "закрыты" : "открыты") +
  "  Правые=" + (gs.right.closed ? "закрыты" : "открыты"));

})();
