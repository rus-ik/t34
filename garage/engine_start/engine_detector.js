// engine_detector.js — wb-rules (Duktape / ECMAScript 5)
// Загрузить в: /etc/wb-rules/engine_detector.js

// ═══════════════════════════════════════════════════════
// НАСТРОЙКИ
// ═══════════════════════════════════════════════════════

var DEVICE_A    = "wb-msw-v4_36";   // правая стена
var DEVICE_B    = "wb-msw-v4_110";  // задняя стена

var DEBUG_MODE  = true;

// ── Медленный цикл (CDS → Confirmed + резервный сброс) ──
var POLL_MS       = 3000;  // интервал медленного цикла, мс
var BASELINE_N    = 200;   // глубина базовой линии (200 × 3 с = 10 мин)
var MIN_SAMPLES   = 20;    // отсчётов до первой детекции (20 × 3 с = 60 с)
var T_CONFIRM     = 3.5;   // CDS ≥ T_CONFIRM × CONFIRM_POLLS подряд → Confirmed
var T_RESET       = 1.0;   // CDS < T_RESET  × RESET_POLLS  подряд → резервный сброс
var CONFIRM_POLLS = 3;
var RESET_POLLS   = 3;

// Веса CDS (сумма = 1.0)
var W_CO2   = 0.25;
var W_VOC   = 0.30;
var W_SOUND = 0.35;
var W_TEMP  = 0.10;

// ── MTD262-MB mmWave (потолок, вибрация от двигателя) ───
var MTD_A = "mtdx62-mb_30";  // над слотом 1 (левый)
var MTD_B = "mtdx62-mb_34";  // над слотом 2 (правый)

// ── LiDAR WT53R (опционально) ───────────────────────────
var USE_LIDAR   = false;    // false — лидар не установлен
var LIDAR_A     = "wt53r_1";
var LIDAR_B     = "wt53r_2";
var LIDAR_MAX_M = 2.0;      // м — машина присутствует если Distance < этого

// ── Быстрый цикл (MDT + Sound → Alert за 5-10 с) ────────
var FAST_POLL_MS     = 1000; // интервал быстрого цикла, мс
var FAST_ALERT_POLLS = 5;    // сек подряд MDT+Sound активны → Alert
var FAST_SND_DELTA   = 2.0;  // σ Sound выше базовой линии (минимум)
var FAST_RESET_POLLS = 15;   // сек MDT неактивен при alert=true → сброс

// ═══════════════════════════════════════════════════════
// ТОПИКИ
// ═══════════════════════════════════════════════════════

var TA_CO2   = DEVICE_A + "/CO2";
var TA_VOC   = DEVICE_A + "/Air Quality (VOC)";
var TA_SOUND = DEVICE_A + "/Sound Level";
var TA_TEMP  = DEVICE_A + "/Temperature";
var TA_HUM   = DEVICE_A + "/Humidity";

var TB_CO2   = DEVICE_B + "/CO2";
var TB_VOC   = DEVICE_B + "/Air Quality (VOC)";
var TB_SOUND = DEVICE_B + "/Sound Level";
var TB_TEMP  = DEVICE_B + "/Temperature";
var TB_HUM   = DEVICE_B + "/Humidity";

var TA_MDT   = MTD_A + "/Presence Status";
var TB_MDT   = MTD_B + "/Presence Status";
var TA_LIDAR = LIDAR_A + "/Distance";
var TB_LIDAR = LIDAR_B + "/Distance";

// ═══════════════════════════════════════════════════════
// КОЛЬЦЕВОЙ БУФЕР
// ═══════════════════════════════════════════════════════

function makeRing(size) {
  return { buf: [], head: 0, count: 0, size: size };
}

function ringPush(r, v) {
  r.buf[r.head] = v;
  r.head = (r.head + 1) % r.size;
  if (r.count < r.size) r.count++;
}

function ringMean(r) {
  if (r.count === 0) return 0;
  var s = 0;
  for (var i = 0; i < r.count; i++) s += r.buf[i];
  return s / r.count;
}

function ringSigma(r, mean) {
  if (r.count < 5) return 1.0;
  var v = 0, d;
  for (var i = 0; i < r.count; i++) {
    d = r.buf[i] - mean;
    v += d * d;
  }
  var sigma = Math.sqrt(v / r.count);
  return sigma < 0.5 ? 0.5 : sigma;
}

// ═══════════════════════════════════════════════════════
// СОСТОЯНИЕ
// ═══════════════════════════════════════════════════════

var raw = {
  co2_a: 0,  co2_b: 0,
  voc_a: 0,  voc_b: 0,
  snd_a: 0,  snd_b: 0,
  tmp_a: 0,  tmp_b: 0,
  hum_a: 50, hum_b: 50,
  mdt_a: 0,  mdt_b: 0,
  lidar_a: 99, lidar_b: 99  // 99 = нет данных
};

var rings = {
  co2:   makeRing(BASELINE_N),
  voc:   makeRing(BASELINE_N),
  sound: makeRing(BASELINE_N),
  temp:  makeRing(BASELINE_N)
};

var alarm = {
  alertActive:    false,
  confirmActive:  false,
  confirmCount:   0,
  resetCount:     0,
  fastCount:      0,   // подряд сек: MDT+Sound активны → переход в Alert
  fastResetCount: 0,   // подряд сек: MDT неактивен при alert=true
  lastAlertTs:    ""
};

// ═══════════════════════════════════════════════════════
// ВИРТУАЛЬНОЕ УСТРОЙСТВО
// ═══════════════════════════════════════════════════════

defineVirtualDevice("engine_detector", {
  title: "Engine Detector (гараж)",
  cells: {
    Alert:       { type: "switch", value: false, title: "Быстрая детекция"       },
    Confirmed:   { type: "switch", value: false, title: "Устойчивая детекция"    },
    CDS:         { type: "value",  value: 0,     title: "CDS score"              },
    FastCount:   { type: "value",  value: 0,     title: "Fast detect count"      },
    Mdt1:        { type: "switch", value: false, title: "MDT слот 1 (вибрация)"  },
    Mdt2:        { type: "switch", value: false, title: "MDT слот 2 (вибрация)"  },
    BaseReady:   { type: "switch", value: false, title: "База готова"            },
    SampleCount: { type: "value",  value: 0,     title: "Отсчётов в базе"        },
    LastAlert:   { type: "text",   value: "",    title: "Последняя тревога"      },
    CO2_delta:   { type: "value",  value: 0,     title: "CO2 delta σ"            },
    VOC_delta:   { type: "value",  value: 0,     title: "VOC delta σ"            },
    Sound_delta: { type: "value",  value: 0,     title: "Sound delta σ"          },
    Temp_delta:  { type: "value",  value: 0,     title: "Temp delta σ"           }
  }
});

// ═══════════════════════════════════════════════════════
// ПОДПИСКИ
// ═══════════════════════════════════════════════════════

defineRule("ed_co2_a",  { whenChanged: TA_CO2,   then: function(v) { raw.co2_a = +v || 0;  } });
defineRule("ed_co2_b",  { whenChanged: TB_CO2,   then: function(v) { raw.co2_b = +v || 0;  } });
defineRule("ed_voc_a",  { whenChanged: TA_VOC,   then: function(v) { raw.voc_a = +v || 0;  } });
defineRule("ed_voc_b",  { whenChanged: TB_VOC,   then: function(v) { raw.voc_b = +v || 0;  } });
defineRule("ed_snd_a",  { whenChanged: TA_SOUND, then: function(v) { raw.snd_a = +v || 0;  } });
defineRule("ed_snd_b",  { whenChanged: TB_SOUND, then: function(v) { raw.snd_b = +v || 0;  } });
defineRule("ed_tmp_a",  { whenChanged: TA_TEMP,  then: function(v) { raw.tmp_a = +v || 0;  } });
defineRule("ed_tmp_b",  { whenChanged: TB_TEMP,  then: function(v) { raw.tmp_b = +v || 0;  } });
defineRule("ed_hum_a",  { whenChanged: TA_HUM,   then: function(v) { raw.hum_a = +v || 50; } });
defineRule("ed_hum_b",  { whenChanged: TB_HUM,   then: function(v) { raw.hum_b = +v || 50; } });
defineRule("ed_mdt_a",  { whenChanged: TA_MDT,   then: function(v) { raw.mdt_a = +v || 0;  } });
defineRule("ed_mdt_b",  { whenChanged: TB_MDT,   then: function(v) { raw.mdt_b = +v || 0;  } });

if (USE_LIDAR) {
  defineRule("ed_lidar_a", { whenChanged: TA_LIDAR, then: function(v) { raw.lidar_a = +v || 99; } });
  defineRule("ed_lidar_b", { whenChanged: TB_LIDAR, then: function(v) { raw.lidar_b = +v || 99; } });
}

// ═══════════════════════════════════════════════════════
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ═══════════════════════════════════════════════════════

function maxOf(a, b) { return a > b ? a : b; }
function avgOf(a, b) { return (a + b) / 2; }

function deltaV(ring, cur) {
  var mean  = ringMean(ring);
  var sigma = ringSigma(ring, mean);
  var d = (cur - mean) / sigma;
  return d > 0 ? d : 0;
}

function humidityCorrection(rh) {
  if (rh <= 50) return 1.0;
  return 1.0 / (1.0 + 0.01 * (rh - 50));
}

function round2(v) { return Math.round(v * 100) / 100; }

function fireAlert(source, details) {
  alarm.alertActive    = true;
  alarm.fastCount      = 0;
  alarm.fastResetCount = 0;
  alarm.lastAlertTs    = new Date().toISOString();
  dev["engine_detector/LastAlert"] = alarm.lastAlertTs;
  dev["engine_detector/Alert"]     = true;
  log("ENGINE ALERT (" + source + "): " + details + " at " + alarm.lastAlertTs);
}

function clearAlarm(reason) {
  log("ENGINE cleared: " + reason);
  alarm.alertActive    = false;
  alarm.confirmActive  = false;
  alarm.confirmCount   = 0;
  alarm.resetCount     = 0;
  alarm.fastCount      = 0;
  alarm.fastResetCount = 0;
  dev["engine_detector/Alert"]     = false;
  dev["engine_detector/Confirmed"] = false;
}

var _dbgSlowMs = 0;
var _dbgFastMs = 0;

function dbgSlow(msg) {
  if (!DEBUG_MODE) return;
  var now = Date.now();
  if (now - _dbgSlowMs < 3000) return;
  _dbgSlowMs = now;
  log("[DBG slow] " + msg);
}

function dbgFast(msg) {
  if (!DEBUG_MODE) return;
  var now = Date.now();
  if (now - _dbgFastMs < 1000) return;
  _dbgFastMs = now;
  log("[DBG fast] " + msg);
}

// ═══════════════════════════════════════════════════════
// БЫСТРЫЙ ЦИКЛ — MDT262 + Sound (+ LiDAR опционально)
// Цель: Alert за FAST_ALERT_POLLS секунд
// Сброс: при MDT неактивен FAST_RESET_POLLS секунд подряд
// ═══════════════════════════════════════════════════════

setInterval(function() {

  var mdtA = raw.mdt_a > 0;
  var mdtB = raw.mdt_b > 0;
  var mdtActive = mdtA || mdtB;

  dev["engine_detector/Mdt1"] = mdtA;
  dev["engine_detector/Mdt2"] = mdtB;

  var lidarOk = true;
  if (USE_LIDAR) {
    lidarOk = (raw.lidar_a > 0 && raw.lidar_a < LIDAR_MAX_M) ||
              (raw.lidar_b > 0 && raw.lidar_b < LIDAR_MAX_M);
  }

  var sound    = maxOf(raw.snd_a, raw.snd_b);
  var sndReady = rings.sound.count >= MIN_SAMPLES;
  var sndDelta = sndReady ? deltaV(rings.sound, sound) : 0;
  var soundOk  = sndDelta >= FAST_SND_DELTA;

  // Счётчик нарастания — только пока Alert не активен
  if (!alarm.alertActive) {
    if (mdtActive && soundOk && lidarOk && sndReady) {
      alarm.fastCount++;
    } else {
      alarm.fastCount = 0;
    }
    dev["engine_detector/FastCount"] = alarm.fastCount;

    if (alarm.fastCount >= FAST_ALERT_POLLS) {
      fireAlert("fast",
        "MDT1=" + (mdtA ? 1 : 0) +
        " MDT2=" + (mdtB ? 1 : 0) +
        " sndD=" + round2(sndDelta) +
        (USE_LIDAR ? (" lidar=" + (lidarOk ? 1 : 0)) : ""));
    }
  }

  // Сброс: MDT неактивен FAST_RESET_POLLS сек при активной тревоге
  if (alarm.alertActive) {
    if (!mdtActive) {
      alarm.fastResetCount++;
      if (alarm.fastResetCount >= FAST_RESET_POLLS) {
        clearAlarm("MDT inactive " + FAST_RESET_POLLS + "s");
      }
    } else {
      alarm.fastResetCount = 0;
    }
  }

  dbgFast("mdt=" + (mdtActive ? 1 : 0) +
          " sndD=" + round2(sndDelta) +
          " sndRdy=" + (sndReady ? 1 : 0) +
          (USE_LIDAR ? (" lidar=" + (lidarOk ? 1 : 0)) : "") +
          " fastCnt=" + alarm.fastCount +
          " frstCnt=" + alarm.fastResetCount +
          " alert=" + alarm.alertActive);

}, FAST_POLL_MS);

// ═══════════════════════════════════════════════════════
// МЕДЛЕННЫЙ ЦИКЛ — CDS (CO2 + VOC + Sound + Temp)
// Цель: Confirmed + резервный сброс через CDS-гистерезис
// ═══════════════════════════════════════════════════════

setInterval(function() {

  // 1. Комбинированные значения
  var co2   = maxOf(raw.co2_a, raw.co2_b);
  var voc   = maxOf(raw.voc_a, raw.voc_b);
  var sound = maxOf(raw.snd_a, raw.snd_b);
  var temp  = avgOf(raw.tmp_a, raw.tmp_b);
  var hum   = avgOf(raw.hum_a, raw.hum_b);

  // 2. Базовая линия — только пока тревога неактивна
  if (!alarm.alertActive) {
    ringPush(rings.co2,   co2);
    ringPush(rings.voc,   voc);
    ringPush(rings.sound, sound);
    ringPush(rings.temp,  temp);
  }

  // 3. Прогрев
  var minCount = Math.min(
    rings.co2.count, rings.voc.count,
    rings.sound.count, rings.temp.count
  );
  var baseReady = minCount >= MIN_SAMPLES;

  dev["engine_detector/BaseReady"]   = baseReady;
  dev["engine_detector/SampleCount"] = minCount;

  if (!baseReady) {
    dbgSlow("warmup: " + minCount + "/" + MIN_SAMPLES);
    return;
  }

  // 4. Нормализованные отклонения
  var d_co2   = deltaV(rings.co2,   co2);
  var d_voc   = deltaV(rings.voc,   voc);
  var d_sound = deltaV(rings.sound, sound);
  var d_temp  = deltaV(rings.temp,  temp);

  // 5. CDS
  var H   = humidityCorrection(hum);
  var cds = round2((W_CO2 * d_co2 + W_VOC * d_voc + W_SOUND * d_sound + W_TEMP * d_temp) * H);

  dev["engine_detector/CDS"]         = cds;
  dev["engine_detector/CO2_delta"]   = round2(d_co2);
  dev["engine_detector/VOC_delta"]   = round2(d_voc);
  dev["engine_detector/Sound_delta"] = round2(d_sound);
  dev["engine_detector/Temp_delta"]  = round2(d_temp);

  dbgSlow("CDS=" + cds +
      " co2=" + co2 + "(d=" + round2(d_co2) + ")" +
      " voc=" + voc + "(d=" + round2(d_voc) + ")" +
      " snd=" + round2(sound) + "(d=" + round2(d_sound) + ")" +
      " H=" + round2(H) +
      " alert=" + alarm.alertActive +
      " confirmCnt=" + alarm.confirmCount);

  // 6. Confirmed: CDS ≥ T_CONFIRM × CONFIRM_POLLS подряд
  if (cds >= T_CONFIRM) {
    alarm.confirmCount++;
    alarm.resetCount = 0;
  } else if (cds < T_RESET) {
    alarm.resetCount++;
    alarm.confirmCount = 0;
  }
  // нейтральная зона [T_RESET, T_CONFIRM) — счётчики не трогаем

  if (!alarm.confirmActive && alarm.confirmCount >= CONFIRM_POLLS) {
    alarm.confirmActive = true;
    dev["engine_detector/Confirmed"] = true;
    log("ENGINE CONFIRMED: CDS=" + cds +
        " CO2d=" + round2(d_co2) +
        " VOCd=" + round2(d_voc) +
        " Sd="   + round2(d_sound) +
        " Td="   + round2(d_temp));
  }

  // 7. Резервный сброс по CDS (основной — по MDT в быстром цикле)
  if (alarm.alertActive && alarm.resetCount >= RESET_POLLS) {
    clearAlarm("CDS<" + T_RESET + " за " + RESET_POLLS + " опроса (CDS=" + cds + ")");
  }

  dev["engine_detector/Alert"]     = alarm.alertActive;
  dev["engine_detector/Confirmed"] = alarm.confirmActive;

}, POLL_MS);
