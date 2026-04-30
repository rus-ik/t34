// climate/guest-ac.js — Кондиционер Centek CT-65K07 в Гостевой комнате
//
// Аппаратура:
//   WB-MSW v3 #151 (Гостевая) — датчик температуры/влажности и ИК-приёмник/передатчик.
//   Кондиционер Centek CT-65K07 (сплит, штатный пульт).
//
// ИК-команды (слоты ROM1..ROM7 в WB-MSW; обучаются с пульта):
//   ROM1 — POWER OFF
//   ROM2 — COOL  (рекомендуется выставить на пульте 18°C, авто-вентиляция)
//   ROM3 — HEAT  (рекомендуется выставить на пульте 28°C, авто-вентиляция)
//   ROM4..7 — резерв (можно использовать, например, под FAN ONLY, DRY,
//            или дополнительные setpoint'ы; настраивается в коде).
//
// Идея управления:
//   Внутренний термостат AC отрабатывает СВОЙ setpoint, но его сенсор
//   расположен у потолка → менее точен. Поэтому AC выставляем на
//   крайние значения (18°C cool / 28°C heat) — как «полный газ», —
//   а внешний контур wb-rules сам ВКЛючает/ВЫКЛючает кондиционер
//   по реальной температуре в комнате с гистерезисом.
//
// Режимы (mode):
//   off   — кондиционер должен быть выключен
//   cool  — летний режим: COOL при перегреве, OFF при достижении target
//   heat  — межсезонье: HEAT при холоде, OFF при достижении target
//   auto  — комбинированный: cool при жаре, heat при холоде, off в зоне комфорта
//
// Защиты:
//   — COMPRESSOR_COOLDOWN_MS (5 мин) между сменами команды
//   — При молчании датчика > SENSOR_STALE_MS — принудительный OFF
//
// Обучение:
//   Кнопка "learn_*" в vdev переводит соответствующий слот ROM в режим
//   обучения на LEARN_TIMEOUT_MS секунд. В это время нажмите нужную
//   кнопку на пульте AC, направив пульт на датчик (≤2 м, прямая видимость).
//   Слот сохраняет код. Авто-выход из режима обучения по таймауту.

(function () {

// ══════════════════════════════════════════════════════════════════
// АППАРАТНЫЕ ТОПИКИ
// ══════════════════════════════════════════════════════════════════

var MSW        = "wb-msw-v3_151";
var TEMP_TOPIC = MSW + "/Temperature";
var HUM_TOPIC  = MSW + "/Humidity";

var ROM_OFF  = 1;
var ROM_COOL = 2;
var ROM_HEAT = 3;

function playTopic(rom)  { return MSW + "/Play from ROM" + rom; }
function learnTopic(rom) { return MSW + "/Learn to ROM"  + rom; }

// ══════════════════════════════════════════════════════════════════
// НАСТРОЙКИ
// ══════════════════════════════════════════════════════════════════

var TZ_OFFSET_HOURS        = 10;             // Asia/Vladivostok = UTC+10
var DEFAULT_TARGET         = 23;             // °C
var DEFAULT_HYST           = 1;              // °C
var COMPRESSOR_COOLDOWN_MS = 5 * 60 * 1000;  // не чаще раз в 5 мин менять направление
var SENSOR_STALE_MS        = 10 * 60 * 1000; // молчание датчика → safety off
var LEARN_TIMEOUT_MS       = 30 * 1000;      // окно обучения, сек × 1000
var TEMP_PUBLISH_DELTA     = 0.1;            // публиковать temp при ∆ ≥ 0.1°C
var HUM_PUBLISH_DELTA      = 1;              // публиковать hum при ∆ ≥ 1%

// ── Telegram (опционально, через тот же модуль секретов что в gate-control)
var TG_SCRIPT = "/usr/local/bin/t34_send_tg.sh";
var TG_TOKEN  = "";
var TG_CHAT   = "";
try {
  var _s = require("garage_secrets");
  if (_s) { TG_TOKEN = _s.tgToken || ""; TG_CHAT = _s.tgChat || ""; }
} catch (e) {
  log.info("[AC-Гост] garage_secrets не найден — Telegram отключён");
}

var VDEV = "guest_ac";

var ROM_LABELS = {
  1: "OFF",
  2: "COOL",
  3: "HEAT",
  4: "ROM4 (резерв)",
  5: "ROM5 (резерв)",
  6: "ROM6 (резерв)",
  7: "ROM7 (резерв)",
};

// ══════════════════════════════════════════════════════════════════
// СОСТОЯНИЕ
// ══════════════════════════════════════════════════════════════════

var state = {
  acCmd:       "off",   // последняя посланная команда: off|cool|heat
  lastSentAt:  0,
  lastTemp:    null,
  prevTempPub: null,
  prevHumPub:  null,
  staleTimer:  null,
  learnTimers: { 1:null, 2:null, 3:null, 4:null, 5:null, 6:null, 7:null },
};

// ══════════════════════════════════════════════════════════════════
// УТИЛИТЫ
// ══════════════════════════════════════════════════════════════════

function ts() {
  var d = new Date(Date.now() + TZ_OFFSET_HOURS * 3600000);
  return d.toISOString().replace("T", " ").slice(0, 19);
}

function shellQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

function tgSend(text) {
  if (!TG_TOKEN || !TG_CHAT) return;
  var cmd = "MSG=$(cat); bash " + shellQuote(TG_SCRIPT)
          + " " + shellQuote(TG_TOKEN)
          + " " + shellQuote(TG_CHAT)
          + " \"$MSG\" >/dev/null 2>&1";
  runShellCommand(cmd, { input: text, captureOutput: false });
}

function logEvent(msg) {
  log.info("[AC-Гост] " + msg);
  dev[VDEV + "/last_action"] = ts() + " — " + msg;
}

function getMode() {
  var m = String(dev[VDEV + "/mode"] || "off").toLowerCase();
  return (m === "cool" || m === "heat" || m === "auto") ? m : "off";
}

function getTarget() {
  var t = Number(dev[VDEV + "/target"]);
  return isNaN(t) ? DEFAULT_TARGET : t;
}

function getHyst() {
  var h = Number(dev[VDEV + "/hyst"]);
  return (isNaN(h) || h < 1) ? DEFAULT_HYST : h;
}

function setMode(newMode) {
  if (dev[VDEV + "/mode"] === newMode) {
    // значение не меняется — whenChanged не сработает, дёрнем evaluate вручную
    evaluate();
    return;
  }
  dev[VDEV + "/mode"] = newMode;
  logEvent("Режим установлен: " + newMode.toUpperCase());
}

// ══════════════════════════════════════════════════════════════════
// ОТПРАВКА ИК-КОМАНД
// ══════════════════════════════════════════════════════════════════

function sendCmd(cmd, reason) {
  var rom;
  if      (cmd === "off")  rom = ROM_OFF;
  else if (cmd === "cool") rom = ROM_COOL;
  else if (cmd === "heat") rom = ROM_HEAT;
  else return false;

  var now = Date.now();
  // Защита компрессора: смена направления не чаще раз в COMPRESSOR_COOLDOWN_MS
  if (state.acCmd !== cmd && now - state.lastSentAt < COMPRESSOR_COOLDOWN_MS) {
    var leftSec = Math.ceil((COMPRESSOR_COOLDOWN_MS - (now - state.lastSentAt)) / 1000);
    logEvent("Защита компрессора: " + state.acCmd.toUpperCase() + "→" + cmd.toUpperCase() +
             " отложено на " + leftSec + " с (" + reason + ")");
    return false;
  }

  dev[playTopic(rom)] = true;
  state.acCmd            = cmd;
  state.lastSentAt       = now;
  dev[VDEV + "/ac_state"] = cmd;
  logEvent("→ AC: " + cmd.toUpperCase() + " (" + reason + ")");
  return true;
}

// ══════════════════════════════════════════════════════════════════
// РЕШАЮЩАЯ ЛОГИКА
// ══════════════════════════════════════════════════════════════════

function evaluate() {
  if (state.lastTemp === null) return; // нет данных — не действуем

  var temp   = state.lastTemp;
  var mode   = getMode();
  var target = getTarget();
  var hyst   = getHyst();

  if (mode === "off") {
    if (state.acCmd !== "off") sendCmd("off", "режим OFF");
    return;
  }

  var hot  = temp > target + hyst;
  var cold = temp < target - hyst;

  if (mode === "cool") {
    if (hot && state.acCmd !== "cool") {
      sendCmd("cool", "t=" + temp.toFixed(1) + " > " + (target + hyst).toFixed(1));
    } else if (state.acCmd === "cool" && temp <= target - hyst) {
      sendCmd("off", "достиг target (t=" + temp.toFixed(1) + ")");
    }
    return;
  }

  if (mode === "heat") {
    if (cold && state.acCmd !== "heat") {
      sendCmd("heat", "t=" + temp.toFixed(1) + " < " + (target - hyst).toFixed(1));
    } else if (state.acCmd === "heat" && temp >= target + hyst) {
      sendCmd("off", "достиг target (t=" + temp.toFixed(1) + ")");
    }
    return;
  }

  // mode === "auto"
  if      (hot  && state.acCmd !== "cool") sendCmd("cool", "auto: жарко (t=" + temp.toFixed(1) + ")");
  else if (cold && state.acCmd !== "heat") sendCmd("heat", "auto: холодно (t=" + temp.toFixed(1) + ")");
  else if (!hot && !cold && state.acCmd !== "off") sendCmd("off", "auto: в зоне комфорта (t=" + temp.toFixed(1) + ")");
}

// ══════════════════════════════════════════════════════════════════
// СВЕЖЕСТЬ ДАТЧИКА
// ══════════════════════════════════════════════════════════════════

function markTempFresh() {
  if (state.staleTimer) clearTimeout(state.staleTimer);
  if (dev[VDEV + "/temp_ok"] !== true) {
    dev[VDEV + "/temp_ok"] = true;
    log.info("[AC-Гост] Датчик температуры — данные поступают");
  }
  state.staleTimer = setTimeout(function () {
    state.staleTimer = null;
    dev[VDEV + "/temp_ok"] = false;
    var msg = "Датчик температуры молчит > " + (SENSOR_STALE_MS / 60000) + " мин — safety off";
    log.warning("[AC-Гост] " + msg);
    tgSend("[AC-Гост] " + msg + "\nВремя: " + ts());
    if (state.acCmd !== "off") sendCmd("off", "safety: датчик молчит");
  }, SENSOR_STALE_MS);
}

// ══════════════════════════════════════════════════════════════════
// ОБУЧЕНИЕ
// ══════════════════════════════════════════════════════════════════

function startLearn(rom) {
  if (state.learnTimers[rom]) clearTimeout(state.learnTimers[rom]);
  dev[learnTopic(rom)] = true;
  logEvent("Обучение " + ROM_LABELS[rom] + " (ROM" + rom + "): нажмите кнопку на пульте AC " +
           "в течение " + (LEARN_TIMEOUT_MS / 1000) + " с, направив пульт в датчик");
  state.learnTimers[rom] = setTimeout(function () {
    state.learnTimers[rom] = null;
    if (dev[learnTopic(rom)] === true) {
      dev[learnTopic(rom)] = false;
      logEvent("Обучение " + ROM_LABELS[rom] + ": таймаут, режим выключен");
    }
  }, LEARN_TIMEOUT_MS);
}

// ══════════════════════════════════════════════════════════════════
// ВИРТУАЛЬНОЕ УСТРОЙСТВО
// ══════════════════════════════════════════════════════════════════

defineVirtualDevice(VDEV, {
  title: "Гостевая — Кондиционер",
  cells: {
    // ── Состояние (read-only) ─────────────────────────────────────
    room_temp:   { type: "value",      value: 0,     readonly: true, units: "°C", title: "Температура в комнате" },
    room_hum:    { type: "value",      value: 0,     readonly: true, units: "%",  title: "Влажность"             },
    temp_ok:     { type: "switch",     value: false, readonly: true,              title: "Датчик: ОК"            },
    ac_state:    { type: "text",       value: "off", readonly: true,              title: "AC: текущая команда"   },
    last_action: { type: "text",       value: "—",   readonly: true,              title: "Последнее действие"    },

    // ── Настройки ───────────────────────────────────────────────────
    mode:        { type: "text",       value: "off",                  title: "Режим (off / cool / heat / auto)" },
    target:      { type: "range",      value: DEFAULT_TARGET,
                   min: 16, max: 30,                                  title: "Целевая температура, °C"          },
    hyst:        { type: "range",      value: DEFAULT_HYST,
                   min: 1,  max: 5,                                   title: "Гистерезис, °C"                   },

    // ── Кнопки выбора режима ────────────────────────────────────────
    set_off:     { type: "pushbutton",                                 title: "Режим: OFF"                 },
    set_cool:    { type: "pushbutton",                                 title: "Режим: COOL (лето)"         },
    set_heat:    { type: "pushbutton",                                 title: "Режим: HEAT (межсезонье)"   },
    set_auto:    { type: "pushbutton",                                 title: "Режим: AUTO"                },

    // ── Ручная отправка команды (тест) ──────────────────────────────
    cmd_off:     { type: "pushbutton",                                 title: "Послать: OFF (ROM1)"        },
    cmd_cool:    { type: "pushbutton",                                 title: "Послать: COOL (ROM2)"       },
    cmd_heat:    { type: "pushbutton",                                 title: "Послать: HEAT (ROM3)"       },

    // ── Обучение слотов ─────────────────────────────────────────────
    learn_off:   { type: "pushbutton",                                 title: "Обучить: OFF (ROM1)"        },
    learn_cool:  { type: "pushbutton",                                 title: "Обучить: COOL (ROM2)"       },
    learn_heat:  { type: "pushbutton",                                 title: "Обучить: HEAT (ROM3)"       },
    learn_rom4:  { type: "pushbutton",                                 title: "Обучить: ROM4 (резерв)"     },
    learn_rom5:  { type: "pushbutton",                                 title: "Обучить: ROM5 (резерв)"     },
    learn_rom6:  { type: "pushbutton",                                 title: "Обучить: ROM6 (резерв)"     },
    learn_rom7:  { type: "pushbutton",                                 title: "Обучить: ROM7 (резерв)"     },
  },
});

// ══════════════════════════════════════════════════════════════════
// ПРАВИЛА: ДАТЧИК
// ══════════════════════════════════════════════════════════════════

defineRule("ac_guest_temp", {
  whenChanged: TEMP_TOPIC,
  then: function (v) {
    var t = Number(v);
    if (isNaN(t)) return;
    state.lastTemp = t;
    markTempFresh();
    var rounded = Math.round(t * 10) / 10;
    if (state.prevTempPub === null || Math.abs(rounded - state.prevTempPub) >= TEMP_PUBLISH_DELTA) {
      state.prevTempPub = rounded;
      dev[VDEV + "/room_temp"] = rounded;
    }
    evaluate();
  },
});

defineRule("ac_guest_hum", {
  whenChanged: HUM_TOPIC,
  then: function (v) {
    var h = Number(v);
    if (isNaN(h)) return;
    var rounded = Math.round(h);
    if (state.prevHumPub === null || Math.abs(rounded - state.prevHumPub) >= HUM_PUBLISH_DELTA) {
      state.prevHumPub = rounded;
      dev[VDEV + "/room_hum"] = rounded;
    }
  },
});

// ══════════════════════════════════════════════════════════════════
// ПРАВИЛА: ИЗМЕНЕНИЕ ПОЛЬЗОВАТЕЛЬСКИХ НАСТРОЕК
// ══════════════════════════════════════════════════════════════════

defineRule("ac_guest_mode_change", { whenChanged: VDEV + "/mode",   then: evaluate });
defineRule("ac_guest_target",      { whenChanged: VDEV + "/target", then: evaluate });
defineRule("ac_guest_hyst",        { whenChanged: VDEV + "/hyst",   then: evaluate });

defineRule("ac_guest_set_off",  { whenChanged: VDEV + "/set_off",  then: function () { setMode("off");  } });
defineRule("ac_guest_set_cool", { whenChanged: VDEV + "/set_cool", then: function () { setMode("cool"); } });
defineRule("ac_guest_set_heat", { whenChanged: VDEV + "/set_heat", then: function () { setMode("heat"); } });
defineRule("ac_guest_set_auto", { whenChanged: VDEV + "/set_auto", then: function () { setMode("auto"); } });

// ══════════════════════════════════════════════════════════════════
// ПРАВИЛА: РУЧНАЯ ОТПРАВКА КОМАНД
// ══════════════════════════════════════════════════════════════════

defineRule("ac_guest_cmd_off",  { whenChanged: VDEV + "/cmd_off",  then: function () { sendCmd("off",  "ручная кнопка"); } });
defineRule("ac_guest_cmd_cool", { whenChanged: VDEV + "/cmd_cool", then: function () { sendCmd("cool", "ручная кнопка"); } });
defineRule("ac_guest_cmd_heat", { whenChanged: VDEV + "/cmd_heat", then: function () { sendCmd("heat", "ручная кнопка"); } });

// ══════════════════════════════════════════════════════════════════
// ПРАВИЛА: ОБУЧЕНИЕ
// ══════════════════════════════════════════════════════════════════

defineRule("ac_guest_learn_off",  { whenChanged: VDEV + "/learn_off",  then: function () { startLearn(1); } });
defineRule("ac_guest_learn_cool", { whenChanged: VDEV + "/learn_cool", then: function () { startLearn(2); } });
defineRule("ac_guest_learn_heat", { whenChanged: VDEV + "/learn_heat", then: function () { startLearn(3); } });
defineRule("ac_guest_learn_rom4", { whenChanged: VDEV + "/learn_rom4", then: function () { startLearn(4); } });
defineRule("ac_guest_learn_rom5", { whenChanged: VDEV + "/learn_rom5", then: function () { startLearn(5); } });
defineRule("ac_guest_learn_rom6", { whenChanged: VDEV + "/learn_rom6", then: function () { startLearn(6); } });
defineRule("ac_guest_learn_rom7", { whenChanged: VDEV + "/learn_rom7", then: function () { startLearn(7); } });

log.info("[AC-Гост] Скрипт загружен. Режим=" + getMode() +
         " target=" + getTarget() + "°C hyst=" + getHyst() + "°C");

})();
