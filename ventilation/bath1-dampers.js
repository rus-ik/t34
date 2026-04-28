// Управление вентиляционными заслонками — Ванная 1 этаж
//
// Приводы WB-MRM2-mini (curtain1_mode=1):
//   wb-mrm2-mini_50  — N1 Сушилка  (всегда закрыта, сушилки нет)
//   wb-mrm2-mini_64  — N2 Ванная   (открывается при высокой влажности)
//   wb-mrm2-mini_73  — N6 Унитаз   (открывается по датчику протока воды)
//   wb-mrm2-mini_70  — N7 Чердак   (открывается на ATTIC_LEAD_MS раньше,
//                                    закрывается на ATTIC_TRAIL_MS позже)
//
// Датчик протока YF-B1:   wb-mcm8_119, вход 3 (импульсный, счётчик на MQTT)
// Датчик присутствия MTD-262: mtdx62-mb_28/presence_status
// Датчик положения WBIO-DI-HVD-16 (wb-mio-gpio_21:1):
//   IN1 — N1 сушилка  | IN2 — N2 ванная | IN3 — N6 унитаз | IN4 — N7 чердак
//   Оба концевика каждого привода выведены на один вход.
//   HIGH = мотор крутится; LOW = достиг крайнего положения.
//   Позиция = lastCmd[привод] при переходе HIGH→LOW.
//
// TODO: установить WB-MSW в ванной 1эт. и заменить HUMIDITY_TOPIC + VOC_TOPIC

// ── Настройки ────────────────────────────────────────────────────────────────

var HUMIDITY_TOPIC = "wb-msw-v3_XXX/Humidity";       // TODO: заменить на реальный датчик
var VOC_TOPIC      = "wb-msw-v3_XXX/VOC";            // TODO: тот же датчик, VOC Index 0–500
var FLOW_COUNTER   = "wb-mcm8_119/Input 3 counter";  // YF-B1, счётчик импульсов
var PRESENCE_TOPIC = "mtdx62-mb_28/presence_status"; // MTD-262

var HUMIDITY_HIGH  = 65;  // % — порог открытия заслонки ванной
var HUMIDITY_LOW   = 55;  // % — порог закрытия (гистерезис)
var BATH_MIN_ON_MS   = 10 * 60 * 1000;  // 10 мин — минимум работы после открытия
var BATH_MAX_ON_MS   = 60 * 60 * 1000;  // 60 мин — аварийное закрытие
var TOILET_TAIL_MS   =  5 * 60 * 1000;  // 5 мин — период доп.работы после ухода человека
var TOILET_MAX_ON_MS = 30 * 60 * 1000;  // 30 мин — аварийное закрытие унитаза
var FLOW_STOP_MS   =  5 * 1000;       // 5 сек без импульсов → проток прекратился
var FLOW_OPEN_PULSES = 3;             // мин. импульсов для открытия заслонки (защита от обратного хода)

var VOC_HIGH       = 150;             // VOC Index — порог открытия унитаза (калибровать!)
var VOC_LOW        = 100;             // VOC Index — порог закрытия (гистерезис)
var VOC_MIN_ON_MS  =  5 * 60 * 1000; // 5 мин — минимум работы после открытия по VOC

var ATTIC_LEAD_MS  = 2500;  // чердак открывается на 2.5с раньше остальных
var ATTIC_TRAIL_MS = 2500;  // чердак закрывается на 2.5с позже остальных

// ── Топики управления приводами ───────────────────────────────────────────────

var DRYER_OPEN   = "wb-mrm2-mini_50/Curtain 1 Open";
var DRYER_CLOSE  = "wb-mrm2-mini_50/Curtain 1 Close";
var BATH_OPEN    = "wb-mrm2-mini_64/Curtain 1 Open";
var BATH_CLOSE   = "wb-mrm2-mini_64/Curtain 1 Close";
var TOILET_OPEN  = "wb-mrm2-mini_73/Curtain 1 Open";
var TOILET_CLOSE = "wb-mrm2-mini_73/Curtain 1 Close";
var ATTIC_OPEN   = "wb-mrm2-mini_70/Curtain 1 Open";
var ATTIC_CLOSE  = "wb-mrm2-mini_70/Curtain 1 Close";

// ── Топики датчиков положения WBIO-DI-HVD-16 ─────────────────────────────────

var POS_DRYER  = "wb-mio-gpio_21:1/IN1";
var POS_BATH   = "wb-mio-gpio_21:1/IN2";
var POS_TOILET = "wb-mio-gpio_21:1/IN3";
var POS_ATTIC  = "wb-mio-gpio_21:1/IN4";

var VDEV = "vent_bath1";

// ── Предвычисленные топики vdev ───────────────────────────────────────────────

var V_PRESENT       = VDEV + "/present";
var V_BATH_CMD      = VDEV + "/bath_open";
var V_BATH_POS      = VDEV + "/bath_confirmed";
var V_TOILET_CMD    = VDEV + "/toilet_open";
var V_TOILET_POS    = VDEV + "/toilet_confirmed";
var V_ATTIC_CMD     = VDEV + "/attic_open";
var V_ATTIC_POS     = VDEV + "/attic_confirmed";
var V_DRYER_POS     = VDEV + "/dryer_confirmed";
var V_HUMIDITY      = VDEV + "/humidity";
var V_VOC           = VDEV + "/voc";
var V_BATH_REASON   = VDEV + "/bath_reason";
var V_TOILET_REASON = VDEV + "/toilet_reason";

// ── Состояние ────────────────────────────────────────────────────────────────

var bathIsOpen      = false;
var bathOpenAt      = 0;
var toiletIsOpen    = false;
var flowStopped     = false;
var bathMaxTimer    = null;
var toiletMaxTimer  = null;
var toiletTimer     = null;
var flowStopTimer   = null;
var atticCmdOpen    = false;  // команда открытия чердака отправлена
var atticCloseTimer = null;   // таймер отложенного закрытия чердака
var prevHum         = -1;     // последнее опубликованное значение влажности
var flowPulseCount  = 0;      // накопленные импульсы до открытия заслонки
var flowPulseTimer  = null;   // таймер сброса счётчика при ложном срабатывании
var vocHigh         = false;  // VOC выше порога — держим унитаз открытым
var vocOpenAt       = 0;      // когда VOC открыл заслонку унитаза
var prevVoc         = -1;     // последнее опубликованное значение VOC

// Последняя команда на каждый привод — для определения позиции по HVD-16
var lastCmd = { dryer: "close", bath: "close", toilet: "close", attic: "close" };

// ── Управление чердаком ───────────────────────────────────────────────────────

function sendAtticOpen() {
  if (atticCloseTimer) { clearTimeout(atticCloseTimer); atticCloseTimer = null; }
  if (atticCmdOpen) return;
  atticCmdOpen = true;
  lastCmd.attic = "open";
  dev[ATTIC_OPEN] = true;
  dev[V_ATTIC_CMD] = "Открыта";
  log.info("[Вент1] ЧЕРДАК открыть");
}

function sendAtticClose() {
  if (!atticCmdOpen) return;
  if (bathIsOpen || toiletIsOpen) return;
  atticCmdOpen = false;
  lastCmd.attic = "close";
  dev[ATTIC_CLOSE] = true;
  dev[V_ATTIC_CMD] = "Закрыта";
  log.info("[Вент1] ЧЕРДАК закрыть");
}

function scheduleAtticClose() {
  if (atticCloseTimer) return;
  atticCloseTimer = setTimeout(function() {
    atticCloseTimer = null;
    sendAtticClose();
  }, ATTIC_TRAIL_MS);
}

// ── Управление ванной ─────────────────────────────────────────────────────────

function openBath(reason) {
  if (bathIsOpen) return;
  bathIsOpen = true;
  bathOpenAt = Date.now();
  dev[V_BATH_CMD]    = "Открыта";
  dev[V_BATH_REASON] = reason;
  sendAtticOpen();
  setTimeout(function() {
    if (!bathIsOpen) return;
    lastCmd.bath = "open";
    dev[BATH_OPEN] = true;
    log.info("[Вент1] ВАННАЯ открыта (" + reason + ")");
  }, ATTIC_LEAD_MS);
  if (bathMaxTimer) clearTimeout(bathMaxTimer);
  bathMaxTimer = setTimeout(function() {
    bathMaxTimer = null;
    closeBath("таймер 60 мин");
  }, BATH_MAX_ON_MS);
}

function closeBath(reason) {
  if (!bathIsOpen) return;
  bathIsOpen = false;
  lastCmd.bath = "close";
  if (bathMaxTimer) { clearTimeout(bathMaxTimer); bathMaxTimer = null; }
  dev[BATH_CLOSE]    = true;
  dev[V_BATH_CMD]    = "Закрыта";
  dev[V_BATH_REASON] = "";
  log.info("[Вент1] ВАННАЯ закрыта (" + reason + ")");
  scheduleAtticClose();
}

// ── Управление унитазом ───────────────────────────────────────────────────────

function openToilet(reason) {
  if (toiletIsOpen) return;
  toiletIsOpen = true;
  dev[V_TOILET_CMD]    = "Открыта";
  dev[V_TOILET_REASON] = reason;
  sendAtticOpen();
  setTimeout(function() {
    if (!toiletIsOpen) return;
    lastCmd.toilet = "open";
    dev[TOILET_OPEN] = true;
    log.info("[Вент1] УНИТАЗ открыт (" + reason + ")");
  }, ATTIC_LEAD_MS);
  if (toiletMaxTimer) clearTimeout(toiletMaxTimer);
  toiletMaxTimer = setTimeout(function() {
    toiletMaxTimer = null;
    closeToilet("таймер 30 мин");
  }, TOILET_MAX_ON_MS);
}

function closeToilet(reason) {
  if (!toiletIsOpen) return;
  toiletIsOpen   = false;
  flowStopped    = false;
  flowPulseCount = 0;
  if (flowPulseTimer)  { clearTimeout(flowPulseTimer);  flowPulseTimer  = null; }
  if (toiletMaxTimer)  { clearTimeout(toiletMaxTimer);  toiletMaxTimer  = null; }
  lastCmd.toilet = "close";
  if (toiletTimer) { clearTimeout(toiletTimer); toiletTimer = null; }
  dev[TOILET_CLOSE]    = true;
  dev[V_TOILET_CMD]    = "Закрыта";
  dev[V_TOILET_REASON] = "";
  log.info("[Вент1] УНИТАЗ закрыт (" + reason + ")");
  scheduleAtticClose();
}

function startToiletTail(reason) {
  flowStopped = false;
  if (toiletTimer) return;
  if (vocHigh) {
    // VOC ещё высок — не закрываем; период доп.работы запустится когда VOC упадёт
    log.info("[Вент1] Период доп.работы унитаза отложен — VOC высок (" + reason + ")");
    return;
  }
  log.info("[Вент1] Период доп.работы унитаза " + (TOILET_TAIL_MS / 60000) + " мин (" + reason + ")");
  dev[V_TOILET_REASON] = "доп.работа " + (TOILET_TAIL_MS / 60000) + " мин";
  toiletTimer = setTimeout(function() {
    toiletTimer = null;
    if (vocHigh) {
      log.info("[Вент1] УНИТАЗ не закрыт: VOC ещё высок, заслонка остаётся открытой");
      return;
    }
    closeToilet("период доп.работы завершён");
  }, TOILET_TAIL_MS);
}

// ── Ручное управление ─────────────────────────────────────────────────────────

function closeAll(reason) {
  bathIsOpen   = false;
  toiletIsOpen = false;
  flowStopped  = false;
  atticCmdOpen = false;
  if (bathMaxTimer)    { clearTimeout(bathMaxTimer);    bathMaxTimer    = null; }
  if (toiletMaxTimer)  { clearTimeout(toiletMaxTimer);  toiletMaxTimer  = null; }
  if (toiletTimer)     { clearTimeout(toiletTimer);     toiletTimer     = null; }
  if (flowStopTimer)   { clearTimeout(flowStopTimer);   flowStopTimer   = null; }
  if (flowPulseTimer)  { clearTimeout(flowPulseTimer);  flowPulseTimer  = null; }
  if (atticCloseTimer) { clearTimeout(atticCloseTimer); atticCloseTimer = null; }
  flowPulseCount = 0;
  vocHigh        = false;
  lastCmd.bath   = "close";
  lastCmd.toilet = "close";
  lastCmd.attic  = "close";
  dev[BATH_CLOSE]      = true;
  dev[TOILET_CLOSE]    = true;
  dev[ATTIC_CLOSE]     = true;
  dev[V_BATH_CMD]      = "Закрыта";
  dev[V_TOILET_CMD]    = "Закрыта";
  dev[V_ATTIC_CMD]     = "Закрыта";
  dev[V_BATH_REASON]   = "";
  dev[V_TOILET_REASON] = "";
  log.info("[Вент1] " + reason + ": принудительное закрытие всех заслонок");
}

function openAll(reason) {
  if (bathMaxTimer)   { clearTimeout(bathMaxTimer);   bathMaxTimer   = null; }
  if (toiletMaxTimer) { clearTimeout(toiletMaxTimer); toiletMaxTimer = null; }
  if (toiletTimer)    { clearTimeout(toiletTimer);    toiletTimer    = null; }
  if (flowStopTimer)  { clearTimeout(flowStopTimer);  flowStopTimer  = null; }
  bathIsOpen   = true;
  bathOpenAt   = Date.now();
  toiletIsOpen = true;
  flowStopped  = false;
  vocHigh      = false;
  sendAtticOpen();
  setTimeout(function() {
    lastCmd.bath   = "open";
    lastCmd.toilet = "open";
    dev[BATH_OPEN]       = true;
    dev[TOILET_OPEN]     = true;
    dev[V_BATH_CMD]      = "Открыта";
    dev[V_TOILET_CMD]    = "Открыта";
    dev[V_BATH_REASON]   = reason;
    dev[V_TOILET_REASON] = reason;
  }, ATTIC_LEAD_MS);
  log.info("[Вент1] " + reason + ": принудительное открытие всех заслонок");
}

// ── Вспомогательные функции ──────────────────────────────────────────────────

function isPresent() {
  var v = dev[PRESENCE_TOPIC];
  return v === true || v === 1;
}

function onPositionReached(name, cmd) {
  var text = (cmd === "open") ? "Открыта" : "Закрыта";
  log.info("[Вент1] " + name + ": позиция — " + text);
  dev[VDEV + "/" + name + "_confirmed"] = text;
}

// ── Виртуальное устройство ────────────────────────────────────────────────────

defineVirtualDevice(VDEV, {
  title: "Вентиляция — Ванная 1 эт.",
  cells: {
    present:          { type: "switch", value: false,     title: "Присутствие"             },
    bath_open:        { type: "text",   value: "Закрыта", title: "Ванная: команда"         },
    bath_confirmed:   { type: "text",   value: "Закрыта", title: "Ванная: позиция (факт)"  },
    toilet_open:      { type: "text",   value: "Закрыта", title: "Унитаз: команда"         },
    toilet_confirmed: { type: "text",   value: "Закрыта", title: "Унитаз: позиция (факт)" },
    attic_open:       { type: "text",   value: "Закрыта", title: "Чердак: команда"         },
    attic_confirmed:  { type: "text",   value: "Закрыта", title: "Чердак: позиция (факт)" },
    dryer_confirmed:  { type: "text",   value: "Закрыта", title: "Сушилка: позиция (факт)"},
    bath_reason:      { type: "text",   value: "",        title: "Ванная: причина"         },
    toilet_reason:    { type: "text",   value: "",        title: "Унитаз: причина"         },
    humidity:         { type: "value",  value: 0,         title: "Влажность, %"           },
    voc:              { type: "value",  value: 0,         title: "VOC Index"               },
    cmd_close_all:    { type: "pushbutton",               title: "Закрыть все (калибровка)"},
    cmd_open_all:     { type: "pushbutton",               title: "Открыть все"             },
  },
});

// Начальное состояние при загрузке скрипта
dev[DRYER_CLOSE]  = true;
dev[BATH_CLOSE]   = true;
dev[TOILET_CLOSE] = true;
dev[ATTIC_CLOSE]  = true;

// ── Правила ──────────────────────────────────────────────────────────────────

defineRule("vent1_bath_humidity", {
  whenChanged: HUMIDITY_TOPIC,
  then: function(v) {
    var hum = Number(v);
    if (isNaN(hum)) return;
    var rounded = Math.round(hum * 10) / 10;
    if (rounded !== prevHum) {
      prevHum = rounded;
      dev[V_HUMIDITY] = rounded;
    }
    if (!bathIsOpen && hum >= HUMIDITY_HIGH) {
      openBath("влажность " + hum.toFixed(1) + "% ≥ " + HUMIDITY_HIGH + "%");
    } else if (bathIsOpen && hum < HUMIDITY_LOW) {
      var elapsed = Date.now() - bathOpenAt;
      if (elapsed >= BATH_MIN_ON_MS) {
        closeBath("влажность " + hum.toFixed(1) + "% < " + HUMIDITY_LOW + "%");
      }
    }
  },
});

// Колбэк вынесен чтобы не создавать новую функцию на каждый импульс счётчика
function flowStopCallback() {
  flowStopTimer = null;
  if (!isPresent()) {
    startToiletTail("проток прекратился, помещение пусто");
  } else {
    flowStopped = true;
    log.info("[Вент1] Проток прекратился, ожидаем ухода из помещения");
  }
}

defineRule("vent1_toilet_flow", {
  whenChanged: FLOW_COUNTER,
  then: function() {
    if (toiletIsOpen) {
      // Проток продолжается (или начался при уже открытой заслонке): сдвигаем/запускаем таймер остановки
      if (flowStopTimer) clearTimeout(flowStopTimer);
      flowStopTimer = setTimeout(flowStopCallback, FLOW_STOP_MS);
      return;
    }

    // Туалет закрыт: накапливаем импульсы до порога FLOW_OPEN_PULSES
    flowPulseCount++;
    if (flowPulseTimer) clearTimeout(flowPulseTimer);

    if (flowPulseCount < FLOW_OPEN_PULSES) {
      // Порог не достигнут — ждём следующих импульсов.
      // Если пауза FLOW_STOP_MS — считаем ложным срабатыванием (обратный ход) и сбрасываем.
      flowPulseTimer = setTimeout(function() {
        flowPulseTimer = null;
        flowPulseCount = 0;
      }, FLOW_STOP_MS);
      return;
    }

    // Порог достигнут — реальный проток, открываем заслонку
    flowPulseTimer = null;
    flowPulseCount = 0;
    flowStopped = false;
    if (flowStopTimer) { clearTimeout(flowStopTimer); flowStopTimer = null; }
    if (toiletTimer)   { clearTimeout(toiletTimer);   toiletTimer   = null; }
    openToilet("проток воды (YF-B1)");
    flowStopTimer = setTimeout(flowStopCallback, FLOW_STOP_MS);
  },
});

defineRule("vent1_toilet_voc", {
  whenChanged: VOC_TOPIC,
  then: function(v) {
    var voc = Number(v);
    if (isNaN(voc)) return;
    var vocInt = Math.round(voc);
    if (vocInt !== prevVoc) {
      prevVoc = vocInt;
      dev[V_VOC] = vocInt;
    }

    if (!vocHigh && voc >= VOC_HIGH) {
      vocHigh   = true;
      vocOpenAt = Date.now();
      openToilet("VOC " + vocInt + " ≥ " + VOC_HIGH);
    } else if (vocHigh && voc < VOC_LOW) {
      vocHigh = false;
      // Если заслонка открыта и таймер периода доп.работы не запущен — запускаем его
      if (toiletIsOpen && !toiletTimer) {
        var elapsed = Date.now() - vocOpenAt;
        if (elapsed >= VOC_MIN_ON_MS) {
          startToiletTail("VOC " + vocInt + " < " + VOC_LOW);
        } else {
          var remaining = VOC_MIN_ON_MS - elapsed;
          setTimeout(function() {
            if (toiletIsOpen && !toiletTimer && !vocHigh) {
              startToiletTail("VOC min-on истёк");
            }
          }, remaining);
        }
      }
    }
  },
});

defineRule("vent1_presence", {
  whenChanged: PRESENCE_TOPIC,
  then: function(v) {
    var present = (v === true || v === 1);
    dev[V_PRESENT] = present;
    if (present) return;
    if (flowStopped) {
      startToiletTail("человек вышел");
    }
    if (bathIsOpen) {
      var hum = Number(dev[HUMIDITY_TOPIC]);
      var elapsed = Date.now() - bathOpenAt;
      if (!isNaN(hum) && hum < HUMIDITY_LOW && elapsed >= BATH_MIN_ON_MS) {
        closeBath("человек вышел, влажность " + hum.toFixed(1) + "%");
      }
    }
  },
});

var posByCell = { "IN1": "dryer", "IN2": "bath", "IN3": "toilet", "IN4": "attic" };

defineRule("vent1_pos", {
  whenChanged: [POS_DRYER, POS_BATH, POS_TOILET, POS_ATTIC],
  then: function(v, devName, cellName) {
    if (v === true || v === 1) return;
    var name = posByCell[cellName];
    if (name) onPositionReached(name, lastCmd[name]);
  },
});

defineRule("vent1_nightly_calibrate", {
  when: function() { return cron("0 3 * * *"); },
  then: function() { closeAll("ночная калибровка 03:00"); },
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
