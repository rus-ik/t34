// Управление вентиляционными заслонками — Ванная 1 этаж
//
// Приводы WB-MRM2-mini (curtain1_mode=1):
//   wb-mrm2-mini_50  — N1 Сушилка  (всегда закрыта, сушилки нет)
//   wb-mrm2-mini_64  — N2 Ванная   (открывается при высокой влажности)
//   wb-mrm2-mini_73  — N6 Унитаз   (открывается по датчику протока + VOC)
//   wb-mrm2-mini_70  — N7 Чердак   (открывается на ATTIC_LEAD_MS раньше,
//                                    закрывается на ATTIC_TRAIL_MS позже)
//
// Датчик протока YF-B1: wb-mcm8_119/Input 3 counter
// Датчик присутствия:   mtdx62-mb_28/presence_status
// Датчик положения WBIO-DI-HVD-16: wb-mio-gpio_21:1/IN1..IN4
//   HIGH = мотор крутится; LOW = достиг крайнего положения.
//   Позиция = lastCmd[привод] при переходе HIGH→LOW.
//
// TODO: установить WB-MSW в ванной 1эт. и заменить HUMIDITY_TOPIC + VOC_TOPIC

(function() {

// ══════════════════════════════════════════════════════════════════
// АППАРАТНЫЕ ТОПИКИ
// ══════════════════════════════════════════════════════════════════

var HUMIDITY_TOPIC = "wb-msw-v3_XXX/Humidity";       // TODO: реальный датчик
var VOC_TOPIC      = "wb-msw-v3_XXX/VOC";            // TODO: тот же датчик
var FLOW_COUNTER   = "wb-mcm8_119/Input 3 counter";
var PRESENCE_TOPIC = "mtdx62-mb_28/presence_status";

// ══════════════════════════════════════════════════════════════════
// НАСТРОЙКИ
// ══════════════════════════════════════════════════════════════════

var TZ_OFFSET_HOURS     = 10;            // Asia/Vladivostok UTC+10
var PULSE_RELAY_MS      = 200;           // длительность импульса на реле
var DAMPER_COOLDOWN_MS  = 1500;          // защита от повторной команды того же направления
var INIT_GUARD_MS       = 2000;          // подавление позиций HVD-16 при запуске
var SENSOR_STALE_MS     = 5 * 60 * 1000; // срок «свежести» датчика
var NIGHT_CALIB_HOUR    = 3;             // 03:00 Vlat

var HUMIDITY_HIGH       = 65;
var HUMIDITY_LOW        = 55;
var BATH_MIN_ON_MS      = 10 * 60 * 1000;
var BATH_MAX_ON_MS      = 60 * 60 * 1000;

var TOILET_TAIL_MIN     = 5;
var TOILET_TAIL_MS      = TOILET_TAIL_MIN * 60 * 1000;
var TOILET_MAX_ON_MS    = 30 * 60 * 1000;

var FLOW_STOP_MS        = 5 * 1000;
var FLOW_OPEN_PULSES    = 3;

var VOC_HIGH            = 150;
var VOC_LOW             = 100;
var VOC_MIN_ON_MS       = 5 * 60 * 1000;

var ATTIC_LEAD_MS       = 2500;
var ATTIC_TRAIL_MS      = 2500;

// ══════════════════════════════════════════════════════════════════
// КОНФИГ ЗАСЛОНОК
// ══════════════════════════════════════════════════════════════════

var D = {
  dryer: {
    label: "СУШИЛКА",
    topics: {
      open:  "wb-mrm2-mini_50/Curtain 1 Open",
      close: "wb-mrm2-mini_50/Curtain 1 Close",
      pos:   "wb-mio-gpio_21:1/IN1",
    },
    state: { lastCmd: "close", busyUntil: 0 },
  },
  bath: {
    label: "ВАННАЯ",
    topics: {
      open:  "wb-mrm2-mini_64/Curtain 1 Open",
      close: "wb-mrm2-mini_64/Curtain 1 Close",
      pos:   "wb-mio-gpio_21:1/IN2",
    },
    state: { open: false, openAt: 0, maxTimer: null, lastCmd: "close", busyUntil: 0 },
  },
  toilet: {
    label: "УНИТАЗ",
    topics: {
      open:  "wb-mrm2-mini_73/Curtain 1 Open",
      close: "wb-mrm2-mini_73/Curtain 1 Close",
      pos:   "wb-mio-gpio_21:1/IN3",
    },
    state: { open: false, maxTimer: null, lastCmd: "close", busyUntil: 0 },
  },
  attic: {
    label: "ЧЕРДАК",
    topics: {
      open:  "wb-mrm2-mini_70/Curtain 1 Open",
      close: "wb-mrm2-mini_70/Curtain 1 Close",
      pos:   "wb-mio-gpio_21:1/IN4",
    },
    state: { open: false, lastCmd: "close", busyUntil: 0, closeTimer: null },
  },
};

var VDEV = "vent_bath1";

var V = {
  present:        VDEV + "/present",
  bath_cmd:       VDEV + "/bath_open",
  bath_pos:       VDEV + "/bath_confirmed",
  bath_reason:    VDEV + "/bath_reason",
  toilet_cmd:     VDEV + "/toilet_open",
  toilet_pos:     VDEV + "/toilet_confirmed",
  toilet_reason:  VDEV + "/toilet_reason",
  attic_cmd:      VDEV + "/attic_open",
  attic_pos:      VDEV + "/attic_confirmed",
  dryer_pos:      VDEV + "/dryer_confirmed",
  humidity:       VDEV + "/humidity",
  humidity_ok:    VDEV + "/humidity_ok",
  voc:            VDEV + "/voc",
  voc_ok:         VDEV + "/voc_ok",
};

// ══════════════════════════════════════════════════════════════════
// СОСТОЯНИЕ (всё, что не привязано к одной заслонке)
// ══════════════════════════════════════════════════════════════════

var state = {
  flowStopped:        false,
  flowStopTimer:      null,
  flowPulseCount:     0,
  flowPulseTimer:     null,
  toiletTailTimer:    null,
  vocHigh:            false,
  vocOpenAt:          0,
  prevHum:            -1,
  prevVoc:            -1,
  humidityStaleTimer: null,
  vocStaleTimer:      null,
  initialized:        false,
};

// ══════════════════════════════════════════════════════════════════
// СЕКРЕТЫ / TELEGRAM
// ══════════════════════════════════════════════════════════════════

var TG_SCRIPT = "/usr/local/bin/t34_send_tg.sh";
var TG_TOKEN  = "";
var TG_CHAT   = "";
try {
  var _s = require("garage_secrets");
  if (_s) { TG_TOKEN = _s.tgToken || ""; TG_CHAT = _s.tgChat || ""; }
} catch (e) {
  log.warning("[Вент1] garage_secrets не найден — Telegram отключён");
}

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

function isPresent() {
  var v = dev[PRESENCE_TOPIC];
  return v === true || v === 1;
}

function publishIfChanged(cell, value, refKey) {
  if (state[refKey] === value) return;
  state[refKey] = value;
  dev[cell] = value;
}

// ══════════════════════════════════════════════════════════════════
// НИЗКОУРОВНЕВОЕ УПРАВЛЕНИЕ ЗАСЛОНКАМИ
// ══════════════════════════════════════════════════════════════════

function pulseRelay(d, dir) {
  var primary   = d.topics[dir];
  var secondary = d.topics[dir === "open" ? "close" : "open"];
  // Сначала гасим противоположную обмотку, затем импульс — true→false
  dev[secondary] = false;
  dev[primary]   = true;
  setTimeout(function() { dev[primary] = false; }, PULSE_RELAY_MS);
}

function damperCmd(name, dir, reason) {
  var d   = D[name];
  var now = Date.now();
  if (now < d.state.busyUntil && d.state.lastCmd === dir) {
    log.info("[Вент1] " + d.label + ": " + dir + " проигнорирована (cooldown), " + reason);
    return false;
  }
  d.state.busyUntil = now + PULSE_RELAY_MS + DAMPER_COOLDOWN_MS;
  d.state.lastCmd   = dir;
  pulseRelay(d, dir);
  log.info("[Вент1] " + d.label + ": " + (dir === "open" ? "открыть" : "закрыть") + " (" + reason + ")");
  return true;
}

// ══════════════════════════════════════════════════════════════════
// ЧЕРДАК
// ══════════════════════════════════════════════════════════════════

function openAttic(reason) {
  if (D.attic.state.closeTimer) {
    clearTimeout(D.attic.state.closeTimer);
    D.attic.state.closeTimer = null;
  }
  if (D.attic.state.open) return;
  D.attic.state.open = true;
  damperCmd("attic", "open", reason);
  dev[V.attic_cmd] = "Открыта";
}

function closeAtticImmediate() {
  if (!D.attic.state.open) return;
  if (D.bath.state.open || D.toilet.state.open) return;
  D.attic.state.open = false;
  damperCmd("attic", "close", "ванная и унитаз закрыты");
  dev[V.attic_cmd] = "Закрыта";
}

function scheduleAtticClose() {
  if (D.attic.state.closeTimer) return;
  D.attic.state.closeTimer = setTimeout(function() {
    D.attic.state.closeTimer = null;
    closeAtticImmediate();
  }, ATTIC_TRAIL_MS);
}

// ══════════════════════════════════════════════════════════════════
// ВАННАЯ
// ══════════════════════════════════════════════════════════════════

function canCloseBath() {
  if (!D.bath.state.open) return false;
  if (Date.now() - D.bath.state.openAt < BATH_MIN_ON_MS) return false;
  var hum = Number(dev[HUMIDITY_TOPIC]);
  return isNaN(hum) || hum < HUMIDITY_HIGH;
}

function bathMaxTimerFired() {
  D.bath.state.maxTimer = null;
  if (!D.bath.state.open) return;
  var hum    = Number(dev[HUMIDITY_TOPIC]);
  var humStr = isNaN(hum) ? "n/a" : hum.toFixed(1) + "%";
  if (!isNaN(hum) && hum >= HUMIDITY_HIGH) {
    log.warning("[Вент1] Аварийный таймер ванной 60 мин: влажность " + humStr + " — продление");
    tgSend("[Вент1] Ванная: продление 60 мин (влажн. " + humStr + ")\nВремя: " + ts());
    D.bath.state.maxTimer = setTimeout(bathMaxTimerFired, BATH_MAX_ON_MS);
    return;
  }
  closeBath("аварийный таймер 60 мин");
  tgSend("[Вент1] Ванная закрыта аварийным таймером\nВремя: " + ts());
}

function openBath(reason) {
  if (D.bath.state.open) return;
  D.bath.state.open    = true;
  D.bath.state.openAt  = Date.now();
  dev[V.bath_cmd]      = "Открыта";
  dev[V.bath_reason]   = reason;
  openAttic(reason);
  setTimeout(function() {
    if (!D.bath.state.open) return;
    damperCmd("bath", "open", reason);
  }, ATTIC_LEAD_MS);
  if (D.bath.state.maxTimer) clearTimeout(D.bath.state.maxTimer);
  D.bath.state.maxTimer = setTimeout(bathMaxTimerFired, BATH_MAX_ON_MS);
}

function closeBath(reason) {
  if (!D.bath.state.open) return;
  D.bath.state.open = false;
  if (D.bath.state.maxTimer) {
    clearTimeout(D.bath.state.maxTimer);
    D.bath.state.maxTimer = null;
  }
  damperCmd("bath", "close", reason);
  dev[V.bath_cmd]    = "Закрыта";
  dev[V.bath_reason] = "";
  scheduleAtticClose();
}

// ══════════════════════════════════════════════════════════════════
// УНИТАЗ
// ══════════════════════════════════════════════════════════════════

function canCloseToilet() {
  return D.toilet.state.open && !state.vocHigh;
}

function toiletMaxTimerFired() {
  D.toilet.state.maxTimer = null;
  if (!D.toilet.state.open) return;
  if (state.vocHigh) {
    log.warning("[Вент1] Аварийный таймер унитаза 30 мин: VOC " + state.prevVoc + " — продление");
    tgSend("[Вент1] Унитаз: продление 30 мин (VOC " + state.prevVoc + ")\nВремя: " + ts());
    D.toilet.state.maxTimer = setTimeout(toiletMaxTimerFired, TOILET_MAX_ON_MS);
    return;
  }
  closeToilet("аварийный таймер 30 мин");
  tgSend("[Вент1] Унитаз закрыт аварийным таймером\nВремя: " + ts());
}

function openToilet(reason) {
  if (D.toilet.state.open) return;
  D.toilet.state.open  = true;
  dev[V.toilet_cmd]    = "Открыта";
  dev[V.toilet_reason] = reason;
  openAttic(reason);
  setTimeout(function() {
    if (!D.toilet.state.open) return;
    damperCmd("toilet", "open", reason);
  }, ATTIC_LEAD_MS);
  if (D.toilet.state.maxTimer) clearTimeout(D.toilet.state.maxTimer);
  D.toilet.state.maxTimer = setTimeout(toiletMaxTimerFired, TOILET_MAX_ON_MS);
}

function closeToilet(reason) {
  if (!D.toilet.state.open) return;
  D.toilet.state.open = false;
  state.flowStopped     = false;
  state.flowPulseCount  = 0;
  if (state.flowPulseTimer)  { clearTimeout(state.flowPulseTimer);  state.flowPulseTimer  = null; }
  if (state.flowStopTimer)   { clearTimeout(state.flowStopTimer);   state.flowStopTimer   = null; }
  if (state.toiletTailTimer) { clearTimeout(state.toiletTailTimer); state.toiletTailTimer = null; }
  if (D.toilet.state.maxTimer) {
    clearTimeout(D.toilet.state.maxTimer);
    D.toilet.state.maxTimer = null;
  }
  damperCmd("toilet", "close", reason);
  dev[V.toilet_cmd]    = "Закрыта";
  dev[V.toilet_reason] = "";
  scheduleAtticClose();
}

function startToiletTail(reason) {
  state.flowStopped = false;
  if (state.toiletTailTimer) return;
  if (!canCloseToilet()) {
    log.info("[Вент1] Период доп.работы унитаза отложен — VOC высок (" + reason + ")");
    return;
  }
  log.info("[Вент1] Период доп.работы унитаза " + TOILET_TAIL_MIN + " мин (" + reason + ")");
  dev[V.toilet_reason] = "доп.работа " + TOILET_TAIL_MIN + " мин";
  state.toiletTailTimer = setTimeout(function() {
    state.toiletTailTimer = null;
    if (!canCloseToilet()) {
      log.info("[Вент1] УНИТАЗ не закрыт: VOC всё ещё высок");
      return;
    }
    closeToilet("период доп.работы завершён");
  }, TOILET_TAIL_MS);
}

// ══════════════════════════════════════════════════════════════════
// ГРУППОВЫЕ ОПЕРАЦИИ
// ══════════════════════════════════════════════════════════════════

function cancelAllTimers() {
  if (D.bath.state.maxTimer)    { clearTimeout(D.bath.state.maxTimer);    D.bath.state.maxTimer    = null; }
  if (D.toilet.state.maxTimer)  { clearTimeout(D.toilet.state.maxTimer);  D.toilet.state.maxTimer  = null; }
  if (D.attic.state.closeTimer) { clearTimeout(D.attic.state.closeTimer); D.attic.state.closeTimer = null; }
  if (state.flowStopTimer)      { clearTimeout(state.flowStopTimer);      state.flowStopTimer      = null; }
  if (state.flowPulseTimer)     { clearTimeout(state.flowPulseTimer);     state.flowPulseTimer     = null; }
  if (state.toiletTailTimer)    { clearTimeout(state.toiletTailTimer);    state.toiletTailTimer    = null; }
}

function closeAll(reason) {
  cancelAllTimers();
  D.bath.state.open    = false;
  D.toilet.state.open  = false;
  D.attic.state.open   = false;
  state.flowStopped    = false;
  state.flowPulseCount = 0;
  state.vocHigh        = false;
  ["dryer", "bath", "toilet", "attic"].forEach(function(name) {
    damperCmd(name, "close", reason);
  });
  dev[V.bath_cmd]      = "Закрыта";
  dev[V.toilet_cmd]    = "Закрыта";
  dev[V.attic_cmd]     = "Закрыта";
  dev[V.bath_reason]   = "";
  dev[V.toilet_reason] = "";
  log.info("[Вент1] " + reason + ": принудительное закрытие всех заслонок");
}

function openAll(reason) {
  cancelAllTimers();
  D.bath.state.open    = true;
  D.bath.state.openAt  = Date.now();
  D.toilet.state.open  = true;
  state.flowStopped    = false;
  state.vocHigh        = false;
  openAttic(reason);
  setTimeout(function() {
    damperCmd("bath",   "open", reason);
    damperCmd("toilet", "open", reason);
    dev[V.bath_cmd]      = "Открыта";
    dev[V.toilet_cmd]    = "Открыта";
    dev[V.bath_reason]   = reason;
    dev[V.toilet_reason] = reason;
  }, ATTIC_LEAD_MS);
  log.info("[Вент1] " + reason + ": принудительное открытие всех заслонок");
}

// ══════════════════════════════════════════════════════════════════
// ПОЗИЦИЯ HVD-16
// ══════════════════════════════════════════════════════════════════

var posToName = {};
["dryer", "bath", "toilet", "attic"].forEach(function(name) {
  posToName[D[name].topics.pos] = name;
});

function onPositionReached(name) {
  if (!state.initialized) return;
  var d    = D[name];
  var text = d.state.lastCmd === "open" ? "Открыта" : "Закрыта";
  log.info("[Вент1] " + d.label + ": позиция — " + text);
  dev[VDEV + "/" + name + "_confirmed"] = text;
}

// ══════════════════════════════════════════════════════════════════
// СВЕЖЕСТЬ ДАТЧИКОВ
// ══════════════════════════════════════════════════════════════════

function markHumidityFresh() {
  if (state.humidityStaleTimer) clearTimeout(state.humidityStaleTimer);
  if (dev[V.humidity_ok] !== true) {
    dev[V.humidity_ok] = true;
    log.info("[Вент1] Датчик влажности — данные поступают");
  }
  state.humidityStaleTimer = setTimeout(function() {
    state.humidityStaleTimer = null;
    if (dev[V.humidity_ok] !== false) {
      dev[V.humidity_ok] = false;
      log.warning("[Вент1] Датчик влажности молчит > " + (SENSOR_STALE_MS / 60000) + " мин");
    }
  }, SENSOR_STALE_MS);
}

function markVocFresh() {
  if (state.vocStaleTimer) clearTimeout(state.vocStaleTimer);
  if (dev[V.voc_ok] !== true) {
    dev[V.voc_ok] = true;
    log.info("[Вент1] Датчик VOC — данные поступают");
  }
  state.vocStaleTimer = setTimeout(function() {
    state.vocStaleTimer = null;
    if (dev[V.voc_ok] !== false) {
      dev[V.voc_ok] = false;
      log.warning("[Вент1] Датчик VOC молчит > " + (SENSOR_STALE_MS / 60000) + " мин");
    }
  }, SENSOR_STALE_MS);
}

// ══════════════════════════════════════════════════════════════════
// ОБРАБОТЧИКИ ДАТЧИКОВ
// ══════════════════════════════════════════════════════════════════

function onHumidity(hum) {
  if (isNaN(hum)) return;
  markHumidityFresh();
  publishIfChanged(V.humidity, Math.round(hum * 10) / 10, "prevHum");
  if (!D.bath.state.open && hum >= HUMIDITY_HIGH) {
    openBath("влажность " + hum.toFixed(1) + "% ≥ " + HUMIDITY_HIGH + "%");
  } else if (D.bath.state.open && hum < HUMIDITY_LOW && canCloseBath()) {
    closeBath("влажность " + hum.toFixed(1) + "% < " + HUMIDITY_LOW + "%");
  }
}

function onVoc(voc) {
  if (isNaN(voc)) return;
  markVocFresh();
  var vocInt = Math.round(voc);
  publishIfChanged(V.voc, vocInt, "prevVoc");
  if (!state.vocHigh && voc >= VOC_HIGH) {
    state.vocHigh   = true;
    state.vocOpenAt = Date.now();
    openToilet("VOC " + vocInt + " ≥ " + VOC_HIGH);
  } else if (state.vocHigh && voc < VOC_LOW) {
    state.vocHigh = false;
    if (D.toilet.state.open && !state.toiletTailTimer) {
      var elapsed = Date.now() - state.vocOpenAt;
      if (elapsed >= VOC_MIN_ON_MS) {
        startToiletTail("VOC " + vocInt + " < " + VOC_LOW);
      } else {
        setTimeout(function() {
          if (D.toilet.state.open && !state.toiletTailTimer && !state.vocHigh) {
            startToiletTail("VOC min-on истёк");
          }
        }, VOC_MIN_ON_MS - elapsed);
      }
    }
  }
}

function flowStopCallback() {
  state.flowStopTimer = null;
  if (!isPresent()) {
    startToiletTail("проток прекратился, помещение пусто");
  } else {
    state.flowStopped = true;
    log.info("[Вент1] Проток прекратился, ожидаем ухода из помещения");
  }
}

function onFlowPulse() {
  if (D.toilet.state.open) {
    if (state.flowStopTimer) clearTimeout(state.flowStopTimer);
    state.flowStopTimer = setTimeout(flowStopCallback, FLOW_STOP_MS);
    return;
  }
  state.flowPulseCount++;
  if (state.flowPulseTimer) clearTimeout(state.flowPulseTimer);
  if (state.flowPulseCount < FLOW_OPEN_PULSES) {
    state.flowPulseTimer = setTimeout(function() {
      state.flowPulseTimer = null;
      state.flowPulseCount = 0;
    }, FLOW_STOP_MS);
    return;
  }
  state.flowPulseTimer = null;
  state.flowPulseCount = 0;
  state.flowStopped    = false;
  if (state.toiletTailTimer) { clearTimeout(state.toiletTailTimer); state.toiletTailTimer = null; }
  openToilet("проток воды (YF-B1)");
  state.flowStopTimer = setTimeout(flowStopCallback, FLOW_STOP_MS);
}

// ══════════════════════════════════════════════════════════════════
// НОЧНАЯ КАЛИБРОВКА (событийная, без cron)
// ══════════════════════════════════════════════════════════════════

function scheduleNightlyCalibrate() {
  // Asia/Vladivostok = UTC+10. Считаем следующий 03:00 Vlat в UTC-ms.
  var now      = Date.now();
  var nowVlat  = new Date(now + TZ_OFFSET_HOURS * 3600000);
  var year     = nowVlat.getUTCFullYear();
  var month    = nowVlat.getUTCMonth();
  var day      = nowVlat.getUTCDate();
  if (nowVlat.getUTCHours() >= NIGHT_CALIB_HOUR) day += 1;
  var targetMs = Date.UTC(year, month, day, NIGHT_CALIB_HOUR, 0, 0) - TZ_OFFSET_HOURS * 3600000;
  setTimeout(function() {
    closeAll("ночная калибровка " + NIGHT_CALIB_HOUR + ":00 Vlat");
    scheduleNightlyCalibrate();
  }, targetMs - now);
}

// ══════════════════════════════════════════════════════════════════
// ВИРТУАЛЬНОЕ УСТРОЙСТВО
// ══════════════════════════════════════════════════════════════════

defineVirtualDevice(VDEV, {
  title: "Вентиляция — Ванная 1 эт.",
  cells: {
    present:          { type: "switch",     value: false,     title: "Присутствие"             },
    bath_open:        { type: "text",       value: "Закрыта", title: "Ванная: команда"         },
    bath_confirmed:   { type: "text",       value: "Закрыта", title: "Ванная: позиция (факт)"  },
    bath_reason:      { type: "text",       value: "",        title: "Ванная: причина"         },
    toilet_open:      { type: "text",       value: "Закрыта", title: "Унитаз: команда"         },
    toilet_confirmed: { type: "text",       value: "Закрыта", title: "Унитаз: позиция (факт)"  },
    toilet_reason:    { type: "text",       value: "",        title: "Унитаз: причина"         },
    attic_open:       { type: "text",       value: "Закрыта", title: "Чердак: команда"         },
    attic_confirmed:  { type: "text",       value: "Закрыта", title: "Чердак: позиция (факт)"  },
    dryer_confirmed:  { type: "text",       value: "Закрыта", title: "Сушилка: позиция (факт)" },
    humidity:         { type: "value",      value: 0,         title: "Влажность, %"            },
    humidity_ok:      { type: "switch",     value: false, readonly: true, title: "Датчик влажн.: ОК" },
    voc:              { type: "value",      value: 0,         title: "VOC Index"               },
    voc_ok:           { type: "switch",     value: false, readonly: true, title: "Датчик VOC: ОК"     },
    cmd_close_all:    { type: "pushbutton",                   title: "Закрыть все (калибровка)" },
    cmd_open_all:     { type: "pushbutton",                   title: "Открыть все"              },
  },
});

// ══════════════════════════════════════════════════════════════════
// ИНИЦИАЛИЗАЦИЯ
// ══════════════════════════════════════════════════════════════════

// Стартовое закрытие всех заслонок (и сброс реле в нулевое положение)
["dryer", "bath", "toilet", "attic"].forEach(function(name) {
  damperCmd(name, "close", "запуск скрипта");
});

// Подавление ложных «достигнута позиция» от retained MQTT-значений
setTimeout(function() { state.initialized = true; }, INIT_GUARD_MS);

scheduleNightlyCalibrate();

if (HUMIDITY_TOPIC.indexOf("XXX") >= 0) {
  log.warning("[Вент1] HUMIDITY_TOPIC всё ещё placeholder — установите датчик WB-MSW");
}

// ══════════════════════════════════════════════════════════════════
// ПРАВИЛА
// ══════════════════════════════════════════════════════════════════

defineRule("vent1_air", {
  whenChanged: [HUMIDITY_TOPIC, VOC_TOPIC],
  then: function(v, devName, cellName) {
    var fullPath = devName + "/" + cellName;
    if (fullPath === HUMIDITY_TOPIC) onHumidity(Number(v));
    else if (fullPath === VOC_TOPIC) onVoc(Number(v));
  },
});

defineRule("vent1_flow", {
  whenChanged: FLOW_COUNTER,
  then: onFlowPulse,
});

defineRule("vent1_presence", {
  whenChanged: PRESENCE_TOPIC,
  then: function(v) {
    var present = (v === true || v === 1);
    dev[V.present] = present;
    if (present) return;
    if (state.flowStopped) {
      startToiletTail("человек вышел");
    }
    if (D.bath.state.open && canCloseBath()) {
      var hum    = Number(dev[HUMIDITY_TOPIC]);
      var humStr = isNaN(hum) ? "n/a" : hum.toFixed(1) + "%";
      if (!isNaN(hum) && hum < HUMIDITY_LOW) {
        closeBath("человек вышел, влажность " + humStr);
      }
    }
  },
});

defineRule("vent1_pos", {
  whenChanged: [D.dryer.topics.pos, D.bath.topics.pos, D.toilet.topics.pos, D.attic.topics.pos],
  then: function(v, devName, cellName) {
    if (v === true || v === 1) return;
    var name = posToName[devName + "/" + cellName];
    if (name) onPositionReached(name);
  },
});

defineRule("vent1_cmd_close_all", {
  whenChanged: VDEV + "/cmd_close_all",
  then: function() { closeAll("кнопка"); },
});

defineRule("vent1_cmd_open_all", {
  whenChanged: VDEV + "/cmd_open_all",
  then: function() { openAll("кнопка"); },
});

log.info("[Вент1] Загружен — Ванная 1 эт. Заслонки: N1(сушилка)=ЗАКРЫТА N2(ванная) N6(унитаз) N7(чердак)");

})();
