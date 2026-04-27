// Управление вентиляционными заслонками — Ванная 1 этаж
//
// Приводы WB-MRM2-mini (curtain1_mode=1):
//   wb-mrm2-mini_50  — N1 Сушилка  (всегда закрыта, сушилки нет)
//   wb-mrm2-mini_64  — N2 Ванная   (открывается при высокой влажности)
//   wb-mrm2-mini_73  — N6 Унитаз   (открывается по датчику протока воды)
//   wb-mrm2-mini_70  — N7 Чердак   (открыт пока открыта N2 или N6)
//
// Датчик протока YF-B1:   wb-mcm8_119, вход 3 (импульсный, счётчик на MQTT)
// Датчик присутствия MTD-262: mtdx62-mb_28/presence_status
// Датчик положения WBIO-DI-HVD-16 (wb-mio-gpio_21:1):
//   IN1 — N1 сушилка  | IN2 — N2 ванная | IN3 — N6 унитаз | IN4 — N7 чердак
//   Оба концевика каждого привода выведены на один вход.
//   HIGH = мотор крутится; LOW = достиг крайнего положения.
//   Позиция = lastCmd[привод] при переходе HIGH→LOW.
//
// TODO: установить WB-MSW в ванной 1эт. и заменить HUMIDITY_TOPIC

// ── Настройки ────────────────────────────────────────────────────────────────

var HUMIDITY_TOPIC = "wb-msw-v3_XXX/Humidity";       // TODO: заменить на реальный датчик
var FLOW_COUNTER   = "wb-mcm8_119/Input 3 counter";  // YF-B1, счётчик импульсов
var PRESENCE_TOPIC = "mtdx62-mb_28/presence_status"; // MTD-262

var HUMIDITY_HIGH  = 65;  // % — порог открытия заслонки ванной
var HUMIDITY_LOW   = 55;  // % — порог закрытия (гистерезис)
var BATH_MIN_ON_MS = 10 * 60 * 1000;  // 10 мин — минимум работы после открытия
var BATH_MAX_ON_MS = 60 * 60 * 1000;  // 60 мин — аварийное закрытие
var TOILET_TAIL_MS =  5 * 60 * 1000;  // 5 мин — доработка после ухода человека
var FLOW_STOP_MS   =  5 * 1000;       // 5 сек без импульсов → проток прекратился

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

// ── Состояние ────────────────────────────────────────────────────────────────

var bathIsOpen    = false;
var bathOpenAt    = 0;
var toiletIsOpen  = false;
var flowStopped   = false;
var bathMaxTimer  = null;
var toiletTimer   = null;
var flowStopTimer = null;

// Последняя команда на каждый привод — для определения позиции по HVD-16
var lastCmd = { dryer: "close", bath: "close", toilet: "close", attic: "close" };

// ── Вспомогательные функции ──────────────────────────────────────────────────

function isPresent() {
  var v = dev[PRESENCE_TOPIC];
  return v === true || v === 1;
}

function syncAttic() {
  var open = bathIsOpen || toiletIsOpen;
  if (open) {
    lastCmd.attic = "open";
    dev[ATTIC_OPEN] = true;
  } else {
    lastCmd.attic = "close";
    dev[ATTIC_CLOSE] = true;
  }
  dev[VDEV + "/attic_open"] = open;
}

function openBath(reason) {
  if (bathIsOpen) return;
  bathIsOpen = true;
  bathOpenAt = Date.now();
  lastCmd.bath = "open";
  dev[BATH_OPEN] = true;
  dev[VDEV + "/bath_open"] = true;
  log.info("[Вент1] ВАННАЯ открыта (" + reason + ")");
  syncAttic();
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
  dev[BATH_CLOSE] = true;
  dev[VDEV + "/bath_open"] = false;
  log.info("[Вент1] ВАННАЯ закрыта (" + reason + ")");
  syncAttic();
}

function openToilet(reason) {
  if (toiletIsOpen) return;
  toiletIsOpen = true;
  lastCmd.toilet = "open";
  dev[TOILET_OPEN] = true;
  dev[VDEV + "/toilet_open"] = true;
  log.info("[Вент1] УНИТАЗ открыт (" + reason + ")");
  syncAttic();
}

function closeToilet(reason) {
  if (!toiletIsOpen) return;
  toiletIsOpen = false;
  flowStopped  = false;
  lastCmd.toilet = "close";
  if (toiletTimer) { clearTimeout(toiletTimer); toiletTimer = null; }
  dev[TOILET_CLOSE] = true;
  dev[VDEV + "/toilet_open"] = false;
  log.info("[Вент1] УНИТАЗ закрыт (" + reason + ")");
  syncAttic();
}

function startToiletTail(reason) {
  flowStopped = false;
  if (toiletTimer) return;
  log.info("[Вент1] Хвостовой таймер унитаза " + (TOILET_TAIL_MS / 60000) + " мин (" + reason + ")");
  toiletTimer = setTimeout(function() {
    toiletTimer = null;
    closeToilet("хвост завершён");
  }, TOILET_TAIL_MS);
}

function onPositionReached(name, cmd) {
  var isOpen = (cmd === "open");
  log.info("[Вент1] " + name + ": позиция подтверждена — " + (isOpen ? "ОТКРЫТА" : "ЗАКРЫТА"));
  dev[VDEV + "/" + name + "_confirmed"] = isOpen;
}

// ── Виртуальное устройство ────────────────────────────────────────────────────

defineVirtualDevice(VDEV, {
  title: "Вентиляция — Ванная 1 эт.",
  cells: {
    present:          { type: "switch", value: false, title: "Присутствие"                },
    bath_open:        { type: "switch", value: false, title: "Ванная: команда"            },
    bath_confirmed:   { type: "switch", value: false, title: "Ванная: позиция (факт)"     },
    toilet_open:      { type: "switch", value: false, title: "Унитаз: команда"            },
    toilet_confirmed: { type: "switch", value: false, title: "Унитаз: позиция (факт)"    },
    attic_open:       { type: "switch", value: false, title: "Чердак: команда"            },
    attic_confirmed:  { type: "switch", value: false, title: "Чердак: позиция (факт)"    },
    dryer_confirmed:  { type: "switch", value: false, title: "Сушилка: позиция (факт)"   },
    humidity:         { type: "value",  value: 0,     title: "Влажность, %"              },
  },
});

// Начальное состояние при загрузке скрипта
dev[DRYER_CLOSE]  = true;
dev[BATH_CLOSE]   = true;
dev[TOILET_CLOSE] = true;
dev[ATTIC_CLOSE]  = true;

// ── Правила ──────────────────────────────────────────────────────────────────

// Влажность → заслонка ванной
defineRule("vent1_bath_humidity", {
  whenChanged: HUMIDITY_TOPIC,
  then: function(v) {
    var hum = Number(v);
    if (isNaN(hum)) return;
    dev[VDEV + "/humidity"] = Math.round(hum * 10) / 10;

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

// Проток воды (YF-B1) → заслонка унитаза
defineRule("vent1_toilet_flow", {
  whenChanged: FLOW_COUNTER,
  then: function() {
    flowStopped = false;
    if (flowStopTimer) { clearTimeout(flowStopTimer); flowStopTimer = null; }
    if (toiletTimer)   { clearTimeout(toiletTimer);   toiletTimer   = null; }
    openToilet("проток воды (YF-B1)");

    flowStopTimer = setTimeout(function() {
      flowStopTimer = null;
      if (!isPresent()) {
        startToiletTail("проток прекратился, помещение пусто");
      } else {
        flowStopped = true;
        log.info("[Вент1] Проток прекратился, ожидаем ухода из помещения");
      }
    }, FLOW_STOP_MS);
  },
});

// Датчик присутствия MTD-262
defineRule("vent1_presence", {
  whenChanged: PRESENCE_TOPIC,
  then: function(v) {
    var present = (v === true || v === 1);
    dev[VDEV + "/present"] = present;

    if (present) return;

    // Унитаз: проток уже прекратился пока человек был внутри
    if (flowStopped) {
      startToiletTail("человек вышел");
    }

    // Ванная: человек вышел, влажность упала и минимальное время прошло
    if (bathIsOpen) {
      var hum = Number(dev[HUMIDITY_TOPIC]);
      var elapsed = Date.now() - bathOpenAt;
      if (!isNaN(hum) && hum < HUMIDITY_LOW && elapsed >= BATH_MIN_ON_MS) {
        closeBath("человек вышел, влажность " + hum.toFixed(1) + "%");
      }
    }
  },
});

// Позиция по WBIO-DI-HVD-16: HIGH→LOW = достигли крайнего положения = lastCmd

defineRule("vent1_pos_dryer", {
  whenChanged: POS_DRYER,
  then: function(v) {
    if (v !== true && v !== 1) onPositionReached("dryer", lastCmd.dryer);
  },
});

defineRule("vent1_pos_bath", {
  whenChanged: POS_BATH,
  then: function(v) {
    if (v !== true && v !== 1) onPositionReached("bath", lastCmd.bath);
  },
});

defineRule("vent1_pos_toilet", {
  whenChanged: POS_TOILET,
  then: function(v) {
    if (v !== true && v !== 1) onPositionReached("toilet", lastCmd.toilet);
  },
});

defineRule("vent1_pos_attic", {
  whenChanged: POS_ATTIC,
  then: function(v) {
    if (v !== true && v !== 1) onPositionReached("attic", lastCmd.attic);
  },
});

log.info("[Вент1] Загружен — Ванная 1 эт. Заслонки: N1(сушилка)=ЗАКРЫТА N2(ванная) N6(унитаз) N7(чердак)");
