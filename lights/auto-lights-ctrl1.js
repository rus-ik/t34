// Auto lighting — контроллер 1 (192.168.1.200), 2 этаж + лестница
//
// WB-MSW (ctrl1): v3_189(2С) v4_172(2ДБ) v3_188(2ДМ) v3_198(2СД) v3_183(2СБ) v4_123(Л)
// MTDX62-MB (ctrl1): 55(2С) 22(2ДБ) 31(2ДМ) 29(2СБ)
//
// Тестовый режим: home_lights_c1/test_mode → освещённость игнорируется
// Ночной режим: 22:00–07:00 → освещённость не проверяется
// Звук: только запрещает выключение (не включает свет)
// Связанные комнаты: 2С/2ДБ/2ДМ → Л (лестница включается при движении из комнат)

(function () {

var PFX      = "[C1]";
var VDEV     = "home_lights_c1";
var RULE_PFX = "c1";

var CH_MTD_PRESENCE = "Presence Status";   // прошивка ctrl1 — CamelCase
var CH_MTD_LUX      = "Illuminance status";

var ROOMS = [
  {
    id: "Л", slug: "r_l", name: "Лестница",
    sensors: [{ dev: "wb-msw-v4_123" }],
    mtd: [],
    lights: ["wb-mr6cu_91/K4", "wb-mr6cu_44/K4", "wb-mr6cu_21/K3"],
    linkedRooms: [],
    pirWindowSec: 45, presenceDelaySec: 60, autoOffMin: 10,
    luxOn: 30, luxOff: 50,
  },
  {
    id: "2С", slug: "r_2s", name: "Спальня",
    sensors: [{ dev: "wb-msw-v3_189" }],
    mtd: ["mtdx62-mb_55"],
    lights: ["wb-mr6cu_54/K2", "wb-mr6cu_54/K3"],
    linkedRooms: ["r_l"],
    pirWindowSec: 300, presenceDelaySec: 600, autoOffMin: 120,
    luxOn: 30, luxOff: 50,
  },
  {
    id: "2ДБ", slug: "r_2db", name: "Детская большая",
    sensors: [{ dev: "wb-msw-v4_172" }],
    mtd: ["mtdx62-mb_22"],
    lights: ["wb-mr6cu_91/K1", "wb-mr6cu_91/K2", "wb-mr6cu_78/K6"],
    linkedRooms: ["r_l"],
    pirWindowSec: 180, presenceDelaySec: 300, autoOffMin: 60,
    luxOn: 80, luxOff: 120,
  },
  {
    id: "2ДМ", slug: "r_2dm", name: "Детская малая",
    sensors: [{ dev: "wb-msw-v3_188" }],
    mtd: ["mtdx62-mb_31"],
    lights: ["wb-mr6cu_78/K4", "wb-mr6cu_78/K5"],
    linkedRooms: ["r_l"],
    pirWindowSec: 180, presenceDelaySec: 300, autoOffMin: 60,
    luxOn: 80, luxOff: 120,
  },
  {
    id: "2СД", slug: "r_2sd", name: "Санузел детский",
    sensors: [{ dev: "wb-msw-v3_198" }],
    mtd: [],
    lights: ["wb-mr6cu_78/K2"],
    linkedRooms: [],
    pirWindowSec: 90, presenceDelaySec: 180, autoOffMin: 20,
    luxOn: 50, luxOff: 80,
  },
  {
    id: "2СБ", slug: "r_2sb", name: "Санузел большой",
    sensors: [{ dev: "wb-msw-v3_183" }],
    mtd: ["mtdx62-mb_29"],
    lights: ["wb-mr6cu_54/K5", "wb-mr6cu_54/K6"],
    linkedRooms: [],
    pirWindowSec: 90, presenceDelaySec: 180, autoOffMin: 30,
    luxOn: 50, luxOff: 80,
  },
  // 2К (коридор 2эт, MTD slave_id=5) — реле не определено, добавить позже
];

// ══════════════════════════════════════════════════════════════════════
// Общая логика (идентична ctrl2, отличается только конфиг выше)
// ══════════════════════════════════════════════════════════════════════

var DEFAULT = {
  luxOn:            50,
  luxOff:           80,
  luxCooldownSec:   30,
  pirWindowSec:     120,
  presenceDelaySec: 300,
  autoOffMin:       1,
  maxOnMinutes:     2,
  soundThresholdDb: 45,
};

function def(v, d) { return v !== undefined ? v : d; }

var CH_MOTION = "Current Motion";
var CH_SOUND  = "Sound Level";
var CH_LUX    = "Illuminance";
var TEST_MODE = VDEV + "/test_mode";

var NIGHT_START = 22, NIGHT_END = 7;
var isNight   = false;
var nightHour = -1;
function checkNight() {
  var h = new Date().getHours();
  if (h === nightHour) return isNight;
  nightHour = h;
  return h >= NIGHT_START || h < NIGHT_END;
}

var roomBySlug = {};
for (var rbi = 0; rbi < ROOMS.length; rbi++) roomBySlug[ROOMS[rbi].slug] = rbi;

var rst = [];
for (var bi = 0; bi < ROOMS.length; bi++) {
  var room = ROOMS[bi];
  var cfg = {
    pirWindowMs:        def(room.pirWindowSec,     DEFAULT.pirWindowSec)     * 1000,
    presenceOffDelayMs: def(room.presenceDelaySec, DEFAULT.presenceDelaySec) * 1000,
    autoOffMs:          def(room.autoOffMin,        DEFAULT.autoOffMin)       * 60000,
    maxOnMs:            def(room.maxOnMinutes,      DEFAULT.maxOnMinutes)     * 60000,
    luxCooldownMs:      def(room.luxCooldownSec,    DEFAULT.luxCooldownSec)   * 1000,
    luxOn:              def(room.luxOn,             DEFAULT.luxOn),
    luxOff:             def(room.luxOff,            DEFAULT.luxOff),
    soundThresholdDb:   def(room.soundThresholdDb,  DEFAULT.soundThresholdDb),
  };
  var motionTopics = [], occupancyTopics = [], soundTopics = [];
  var mswLuxTopics = [], mtdLuxTopics = [];
  var pirLastSeen = {}, pirTimers = {}, pirIds = [];
  var si, s, mt, mi;
  for (si = 0; si < room.sensors.length; si++) {
    s  = room.sensors[si];
    mt = s.dev + "/" + CH_MOTION;
    motionTopics.push(mt); pirLastSeen[mt] = 0; pirTimers[mt] = null; pirIds.push(mt);
    soundTopics.push(s.dev + "/" + CH_SOUND);
    mswLuxTopics.push(s.dev + "/" + CH_LUX);
  }
  var mtdArr = room.mtd || [];
  for (mi = 0; mi < mtdArr.length; mi++) {
    occupancyTopics.push(mtdArr[mi] + "/" + CH_MTD_PRESENCE);
    mtdLuxTopics.push(mtdArr[mi] + "/" + CH_MTD_LUX);
  }
  rst.push({
    pfx:          PFX + "[" + room.id + "]",
    vdevLights:   VDEV + "/" + room.slug + "_lights",
    vdevOccupied: VDEV + "/" + room.slug + "_occupied",
    vdevLux:      VDEV + "/" + room.slug + "_lux",
    vdevTrigger:  VDEV + "/" + room.slug + "_trigger",
    lightsOn: false, lightsOnAt: 0, lastLogAt: 0, lastVdevAt: 0,
    manualOff: false, cachedLux: 0,
    autoOffTimer: null, autoOffSetAt: 0, vacantTimer: null, maxOnTimer: null,
    pirLastSeen: pirLastSeen, pirTimers: pirTimers, pirIds: pirIds,
    motionTopics: motionTopics, occupancyTopics: occupancyTopics,
    soundTopics: soundTopics, mswLuxTopics: mswLuxTopics, mtdLuxTopics: mtdLuxTopics,
    cfg: cfg,
  });
}

var vdevCells = {
  test_mode:  { type: "switch", value: false, title: "Тестовый режим (игнорировать освещённость)" },
  night_mode: { type: "switch", value: false, title: "Ночной режим (22:00–07:00)"                 },
  watchdog:   { type: "text",   value: "",    title: "Watchdog"                                   },
};
for (var vi = 0; vi < ROOMS.length; vi++) {
  var vr = ROOMS[vi];
  vdevCells[vr.slug + "_lights"]   = { type: "switch", value: false, title: vr.name + ": Свет"             };
  vdevCells[vr.slug + "_occupied"] = { type: "switch", value: false, title: vr.name + ": Присутствие"       };
  vdevCells[vr.slug + "_lux"]      = { type: "value",  value: 0,     title: vr.name + ": Освещённость, лк"  };
  vdevCells[vr.slug + "_trigger"]  = { type: "text",   value: "",    title: vr.name + ": Последнее событие" };
}
defineVirtualDevice(VDEV, { title: "Свет авто — 2 эт.", cells: vdevCells });

isNight = checkNight();
dev[VDEV + "/night_mode"] = isNight;
if (isNight) log.info(PFX + " Старт в ночном режиме");

for (var ssi = 0; ssi < ROOMS.length; ssi++) {
  var ssRoom = ROOMS[ssi], ssRst = rst[ssi], anyOn = false;
  for (var li = 0; li < ssRoom.lights.length; li++) {
    var lv = dev[ssRoom.lights[li]];
    if (lv === true || lv === 1) { anyOn = true; break; }
  }
  ssRst.lightsOn = anyOn;
  dev[ssRst.vdevLights] = anyOn;
  if (anyOn) log.info(ssRst.pfx + " Реле ON при старте — синхронизировано");
}

function getAvgLux(idx) {
  var sum = 0, count = 0, v, i, topics;
  topics = rst[idx].mswLuxTopics;
  for (i = 0; i < topics.length; i++) {
    v = dev[topics[i]];
    if (v !== undefined && v !== null) { sum += Number(v); count++; }
  }
  if (count > 0) return sum / count;
  topics = rst[idx].mtdLuxTopics;
  for (i = 0; i < topics.length; i++) {
    v = dev[topics[i]];
    if (v !== undefined && v !== null) { sum += Number(v); count++; }
  }
  return count > 0 ? sum / count : 0;
}

function isOccupancyOn(idx) {
  var topics = rst[idx].occupancyTopics;
  for (var i = 0; i < topics.length; i++) {
    var v = dev[topics[i]];
    if (v === true || v === 1) return true;
  }
  return false;
}

function isPirFresh(idx) {
  var pls = rst[idx].pirLastSeen, ids = rst[idx].pirIds;
  for (var i = 0; i < ids.length; i++) { if (pls[ids[i]] > 0) return true; }
  return false;
}

function isSoundActive(idx) {
  var topics = rst[idx].soundTopics, thresh = rst[idx].cfg.soundThresholdDb;
  for (var i = 0; i < topics.length; i++) {
    var v = dev[topics[i]];
    if (v !== undefined && v !== null && Number(v) > thresh) return true;
  }
  return false;
}

function tlog(idx, msg) {
  var now = Date.now();
  if (now - rst[idx].lastLogAt >= 1000) { rst[idx].lastLogAt = now; log.info(msg); }
}

function isActiveForOn(idx)  { return isOccupancyOn(idx) || isPirFresh(idx); }
function isActiveForOff(idx) { return isOccupancyOn(idx) || isPirFresh(idx) || isSoundActive(idx); }

function snapshot(st, lux, now) {
  var parts = ["лк=" + lux.toFixed(1)];
  var ot = st.occupancyTopics, ov = [];
  for (var i = 0; i < ot.length; i++) {
    var v = dev[ot[i]];
    ov.push(ot[i].replace(/\/.*/, "") + "=" + ((v === true || v === 1) ? "1" : "0"));
  }
  if (ov.length) parts.push("присут:[" + ov.join(" ") + "]");
  var ids = st.pirIds, pv = [];
  for (var j = 0; j < ids.length; j++) {
    var age = st.pirLastSeen[ids[j]];
    if (age > 0) pv.push(ids[j].replace(/\/.*/, "") + "=" + Math.round((now - age) / 1000) + "с");
  }
  if (pv.length) parts.push("pir:[" + pv.join(" ") + "]");
  var snd = st.soundTopics, sv = [];
  for (var k = 0; k < snd.length; k++) {
    var sv_v = dev[snd[k]];
    if (sv_v !== undefined && sv_v !== null)
      sv.push(snd[k].replace(/\/.*/, "") + "=" + Number(sv_v).toFixed(0) + "дБ");
  }
  if (sv.length) parts.push("звук:[" + sv.join(" ") + "]");
  parts.push("свет=" + (st.lightsOn ? "ВКЛ" : "ВЫКЛ"));
  parts.push("ночь=" + (isNight ? "ДА" : "НЕТ"));
  parts.push("тест=" + (!!dev[TEST_MODE] ? "ДА" : "НЕТ"));
  return parts.join(" | ");
}

function cancelTimer(idx, key) {
  if (rst[idx][key]) { clearTimeout(rst[idx][key]); rst[idx][key] = null; }
}

function cancelAllTimers(idx) {
  cancelTimer(idx, "autoOffTimer");
  cancelTimer(idx, "vacantTimer");
  cancelTimer(idx, "maxOnTimer");
  rst[idx].autoOffSetAt = 0;
  var st = rst[idx], ids = st.pirIds;
  for (var i = 0; i < ids.length; i++) {
    if (st.pirTimers[ids[i]]) { clearTimeout(st.pirTimers[ids[i]]); st.pirTimers[ids[i]] = null; }
    st.pirLastSeen[ids[i]] = 0;
  }
}

function setLights(room, idx, on, trigger, lux, now) {
  var st = rst[idx], i;
  if (st.lightsOn === on) return;
  st.lightsOn   = on;
  st.lightsOnAt = on ? now : 0;
  for (i = 0; i < room.lights.length; i++) dev[room.lights[i]] = on;
  dev[st.vdevLights]  = on;
  dev[st.vdevTrigger] = trigger;
  var luxVal = (lux !== undefined) ? lux : st.cachedLux;
  log.info(st.pfx + " Свет " + (on ? "ВКЛ" : "ВЫКЛ") +
    " | причина: " + trigger + " | " + snapshot(st, luxVal, now));
}

function armMaxOnTimer(room, idx) {
  cancelTimer(idx, "maxOnTimer");
  rst[idx].maxOnTimer = setTimeout(function () {
    var st = rst[idx]; st.maxOnTimer = null;
    var now = Date.now(), lux = st.cachedLux;
    log.info(st.pfx + " ВЫКЛ по потолку времени | " + snapshot(st, lux, now));
    cancelAllTimers(idx);
    setLights(room, idx, false, "max-on-cap", lux, now);
  }, rst[idx].cfg.maxOnMs);
}

function scheduleAutoOff(room, idx, now) {
  cancelTimer(idx, "autoOffTimer");
  rst[idx].autoOffSetAt = now || Date.now();
  rst[idx].autoOffTimer = setTimeout(function () {
    var st = rst[idx]; st.autoOffTimer = null; st.autoOffSetAt = 0;
    var now2 = Date.now(), lux = st.cachedLux;
    if (!isActiveForOff(idx)) {
      log.info(st.pfx + " ВЫКЛ по авто-таймеру | " + snapshot(st, lux, now2));
      cancelAllTimers(idx);
      setLights(room, idx, false, "auto-off", lux, now2);
    } else {
      log.info(st.pfx + " Авто-таймер сброшен — активность обнаружена | " + snapshot(st, lux, now2));
      scheduleAutoOff(room, idx, now2);
    }
  }, rst[idx].cfg.autoOffMs);
}

var AUTO_OFF_DEBOUNCE_MS = 30000;

function armPirTimer(room, idx, motionTopic) {
  var st = rst[idx];
  if (st.pirTimers[motionTopic]) clearTimeout(st.pirTimers[motionTopic]);
  st.pirTimers[motionTopic] = setTimeout(function () {
    var now = Date.now();
    st.pirTimers[motionTopic]   = null;
    st.pirLastSeen[motionTopic] = 0;
    log.info(st.pfx + " PIR окно истекло: " + motionTopic + " | " + snapshot(st, st.cachedLux, now));
    if (st.lightsOn || isOccupancyOn(idx)) evaluate(room, idx, "pir-expire:" + motionTopic, now);
  }, st.cfg.pirWindowMs);
}

function evaluate(room, idx, trigger, now) {
  if (!now) now = Date.now();
  var st       = rst[idx];
  var nowNight = checkNight();
  if (nowNight !== isNight) {
    isNight = nowNight;
    dev[VDEV + "/night_mode"] = isNight;
    log.info(PFX + " Ночной режим " + (isNight ? "ВКЛ (22:00–07:00)" : "ВЫКЛ"));
  }
  var lux      = st.cachedLux;
  var active   = isActiveForOn(idx);
  var testMode = !!dev[TEST_MODE];
  var luxCool  = st.lightsOnAt > 0 && (now - st.lightsOnAt) < st.cfg.luxCooldownMs;
  var dark     = testMode || isNight || luxCool || lux < (st.lightsOn ? st.cfg.luxOff : st.cfg.luxOn);

  if (active && dark) {
    if (st.vacantTimer) {
      clearTimeout(st.vacantTimer); st.vacantTimer = null;
      log.info(st.pfx + " Таймер вакантности отменён — активность | " + snapshot(st, lux, now));
    }
    if (st.lightsOn) {
      if (st.autoOffTimer === null || now - st.autoOffSetAt > AUTO_OFF_DEBOUNCE_MS)
        scheduleAutoOff(room, idx, now);
    } else if (!st.manualOff) {
      setLights(room, idx, true, trigger, lux, now);
      armMaxOnTimer(room, idx);
      scheduleAutoOff(room, idx, now);
    }
  } else if (active && !dark) {
    log.debug(st.pfx + " Светло — свет не включать | лк=" + lux.toFixed(1));
  } else if (!active) {
    if (st.manualOff) {
      st.manualOff = false;
      log.info(st.pfx + " Присутствие исчезло — ручное выключение снято");
    }
    if (st.lightsOn && st.vacantTimer === null) {
      log.info(st.pfx + " Активности нет — таймер вакантности (" +
        Math.round(st.cfg.presenceOffDelayMs / 1000) + "с) | " + snapshot(st, lux, now));
      st.vacantTimer = setTimeout(function () {
        var now2 = Date.now(); st.vacantTimer = null;
        var lux2 = st.cachedLux;
        if (!isActiveForOff(idx)) {
          log.info(st.pfx + " Вакантность подтверждена — выключаем | " + snapshot(st, lux2, now2));
          cancelAllTimers(idx);
          setLights(room, idx, false, "vacant-confirmed", lux2, now2);
        } else {
          log.info(st.pfx + " Вакантность отменена — активность/звук вернулись | " + snapshot(st, lux2, now2));
        }
      }, st.cfg.presenceOffDelayMs);
    }
  }

  if (now - st.lastVdevAt >= 1000) {
    st.lastVdevAt = now;
    dev[st.vdevLux]         = Math.round(lux * 10) / 10;
    dev[st.vdevOccupied]    = active;
    dev[VDEV + "/watchdog"] = new Date(now).toISOString();
  }
  log.debug(st.pfx + " eval:" + trigger + " act=" + active + " dark=" + dark + " лк=" + lux.toFixed(1));
}

function evaluateLinked(room, trigger, now) {
  var linked = room.linkedRooms || [];
  for (var li = 0; li < linked.length; li++) {
    var li_idx = roomBySlug[linked[li]];
    if (li_idx !== undefined) evaluate(ROOMS[li_idx], li_idx, "linked:" + room.id + ":" + trigger, now);
  }
}

for (var ri = 0; ri < ROOMS.length; ri++) {
  (function (room, idx) {
    var st = rst[idx];

    if (st.motionTopics.length > 0) {
      defineRule(RULE_PFX + "_motion_" + idx, {
        whenChanged: st.motionTopics,
        then: function (v, devName, cellName) {
          if (v === true || v === 1 || Number(v) > 0) {
            var now = Date.now(), topic = devName + "/" + cellName;
            rst[idx].pirLastSeen[topic] = now;
            armPirTimer(room, idx, topic);
            tlog(idx, rst[idx].pfx + " Движение: " + topic + " " + v);
            evaluate(room, idx, "motion:" + topic, now);
            evaluateLinked(room, "motion", now);
          }
        },
      });
    }

    if (st.occupancyTopics.length > 0) {
      defineRule(RULE_PFX + "_occ_" + idx, {
        whenChanged: st.occupancyTopics,
        then: function (v, devName, cellName) {
          var now = Date.now();
          tlog(idx, rst[idx].pfx + " Присутствие: " + devName + " " + v);
          evaluate(room, idx, "occupancy:" + devName, now);
          evaluateLinked(room, "occupancy", now);
        },
      });
    }

    if (st.soundTopics.length > 0) {
      defineRule(RULE_PFX + "_sound_" + idx, {
        whenChanged: st.soundTopics,
        then: function (v) {
          if (v !== undefined && v !== null && Number(v) > st.cfg.soundThresholdDb) {
            tlog(idx, rst[idx].pfx + " Звук: " + Number(v).toFixed(0) + "дБ > " + st.cfg.soundThresholdDb + "дБ");
            if (rst[idx].lightsOn && rst[idx].vacantTimer !== null) {
              clearTimeout(rst[idx].vacantTimer); rst[idx].vacantTimer = null;
              log.info(rst[idx].pfx + " Таймер вакантности отменён по звуку | лк=" + rst[idx].cachedLux.toFixed(1));
            }
          }
        },
      });
    }

    var allLuxTopics = st.mswLuxTopics.concat(st.mtdLuxTopics);
    if (allLuxTopics.length > 0) {
      defineRule(RULE_PFX + "_lux_" + idx, {
        whenChanged: allLuxTopics,
        then: function () {
          rst[idx].cachedLux = getAvgLux(idx);
          if (rst[idx].lightsOn) return;
          evaluate(room, idx, "lux");
        },
      });
    }

    defineRule(RULE_PFX + "_relay_" + idx, {
      whenChanged: room.lights,
      then: function (v, devName, cellName) {
        var anyOn = false;
        for (var rci = 0; rci < room.lights.length; rci++) {
          var rv = dev[room.lights[rci]];
          if (rv === true || rv === 1) { anyOn = true; break; }
        }
        var st2 = rst[idx];
        if (anyOn !== st2.lightsOn) {
          var now = Date.now();
          log.info(st2.pfx + " Реле изменено вручную: " + devName + "/" + cellName + " anyOn=" + anyOn);
          st2.lightsOn   = anyOn;
          st2.lightsOnAt = anyOn ? now : 0;
          st2.manualOff  = !anyOn;
          dev[st2.vdevLights] = anyOn;
          if (!anyOn) {
            cancelAllTimers(idx);
          } else {
            armMaxOnTimer(room, idx);
            scheduleAutoOff(room, idx, now);
          }
        }
      },
    });

  })(ROOMS[ri], ri);
}

defineRule(RULE_PFX + "_test_mode", {
  whenChanged: TEST_MODE,
  then: function (v) {
    log.info(PFX + " Тестовый режим " + (v ? "ВКЛЮЧЁН — освещённость игнорируется" : "ВЫКЛЮЧЕН — нормальная работа"));
    var now = Date.now();
    for (var i = 0; i < ROOMS.length; i++) evaluate(ROOMS[i], i, "test-mode", now);
  },
});

log.info(PFX + " Загружено — комнат: " + ROOMS.length + " — " +
  ROOMS.map(function (r) { return r.id; }).join(", "));

})();
