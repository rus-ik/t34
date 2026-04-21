// engine_detector.js — wb-rules (Duktape / ECMAScript 5)
// Загрузить в: /etc/wb-rules/engine_detector.js

// ═══════════════════════════════════════════════════════
// НАСТРОЙКИ
// ═══════════════════════════════════════════════════════

var DEVICE_A    = "wb-msw-v4_36";   // правая стена
var DEVICE_B    = "wb-msw-v4_110";  // задняя стена

var POLL_MS     = 3000;   // интервал главного цикла, мс
var BASELINE_N  = 200;    // глубина базовой линии (200 × 3 с = 10 мин)
var MIN_SAMPLES = 20;     // отсчётов до первой детекции (20 × 3 с = 60 с)

var DEBUG_MODE  = true;

var T_ALERT         = 2.0;  // CDS ≥ 2.0 → Alert
var T_CONFIRM       = 3.5;  // CDS ≥ 3.5 × CONFIRM_POLLS подряд → Confirmed
var T_RESET         = 1.0;  // CDS < 1.0 × RESET_POLLS подряд → сброс (гистерезис)
var CONFIRM_POLLS   = 3;    // опросов подряд выше T_CONFIRM → Confirmed
var RESET_POLLS     = 3;    // опросов подряд ниже T_RESET   → сброс тревоги

// Веса (сумма = 1.0)
var W_CO2   = 0.25;
var W_VOC   = 0.30;
var W_SOUND = 0.35;
var W_TEMP  = 0.10;

// ═══════════════════════════════════════════════════════
// ТОПИКИ (два датчика)
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

// raw — сырые значения датчиков, обновляются по whenChanged немедленно
var raw = {
  co2_a: 0, co2_b: 0,
  voc_a: 0, voc_b: 0,
  snd_a: 0, snd_b: 0,
  tmp_a: 0, tmp_b: 0,
  hum_a: 50, hum_b: 50
};

// rings — кольцевые буферы базовой линии; не пишутся пока тревога активна
var rings = {
  co2:   makeRing(BASELINE_N),
  voc:   makeRing(BASELINE_N),
  sound: makeRing(BASELINE_N),
  temp:  makeRing(BASELINE_N)
};

var alarm = {
  alertActive:   false,
  confirmActive: false,
  confirmCount:  0,   // подряд идущих опросов с CDS >= T_CONFIRM
  resetCount:    0,   // подряд идущих опросов с CDS < T_RESET
  lastAlertTs:   ""
};

// ═══════════════════════════════════════════════════════
// ВИРТУАЛЬНОЕ УСТРОЙСТВО
// ═══════════════════════════════════════════════════════

defineVirtualDevice("engine_detector", {
  title: "Engine Detector (гараж)",
  cells: {
    CDS:         { type: "value",  value: 0,     title: "CDS score"           },
    Alert:       { type: "switch", value: false,  title: "Быстрая детекция"    },
    Confirmed:   { type: "switch", value: false,  title: "Устойчивая детекция" },
    BaseReady:   { type: "switch", value: false,  title: "База готова"         },
    SampleCount: { type: "value",  value: 0,      title: "Отсчётов в базе"     },
    LastAlert:   { type: "text",   value: "",     title: "Последняя тревога"   },
    CO2_delta:   { type: "value",  value: 0,      title: "CO2 delta σ"         },
    VOC_delta:   { type: "value",  value: 0,      title: "VOC delta σ"         },
    Sound_delta: { type: "value",  value: 0,      title: "Sound delta σ"       },
    Temp_delta:  { type: "value",  value: 0,      title: "Temp delta σ"        }
  }
});

// ═══════════════════════════════════════════════════════
// ПОДПИСКИ — сохраняем сырое значение немедленно, без троттла
// ═══════════════════════════════════════════════════════

defineRule("ed_co2_a",   { whenChanged: TA_CO2,   then: function(v) { raw.co2_a = +v || 0;  } });
defineRule("ed_co2_b",   { whenChanged: TB_CO2,   then: function(v) { raw.co2_b = +v || 0;  } });
defineRule("ed_voc_a",   { whenChanged: TA_VOC,   then: function(v) { raw.voc_a = +v || 0;  } });
defineRule("ed_voc_b",   { whenChanged: TB_VOC,   then: function(v) { raw.voc_b = +v || 0;  } });
defineRule("ed_snd_a",   { whenChanged: TA_SOUND, then: function(v) { raw.snd_a = +v || 0;  } });
defineRule("ed_snd_b",   { whenChanged: TB_SOUND, then: function(v) { raw.snd_b = +v || 0;  } });
defineRule("ed_tmp_a",   { whenChanged: TA_TEMP,  then: function(v) { raw.tmp_a = +v || 0;  } });
defineRule("ed_tmp_b",   { whenChanged: TB_TEMP,  then: function(v) { raw.tmp_b = +v || 0;  } });
defineRule("ed_hum_a",   { whenChanged: TA_HUM,   then: function(v) { raw.hum_a = +v || 50; } });
defineRule("ed_hum_b",   { whenChanged: TB_HUM,   then: function(v) { raw.hum_b = +v || 50; } });

// ═══════════════════════════════════════════════════════
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ═══════════════════════════════════════════════════════

// Комбинирование двух датчиков:
//   CO2, VOC, Sound — максимум (выхлоп концентрируется ближе к одному)
//   Temp, Hum       — среднее
function maxOf(a, b) { return a > b ? a : b; }
function avgOf(a, b) { return (a + b) / 2; }

// Нормализованное отклонение текущего значения от кольцевой базы
function deltaV(ring, cur) {
  var mean  = ringMean(ring);
  var sigma = ringSigma(ring, mean);
  var d = (cur - mean) / sigma;
  return d > 0 ? d : 0;
}

// Влажностный корректор: при высокой влажности CO2/VOC завышаются
function humidityCorrection(rh) {
  if (rh <= 50) return 1.0;
  return 1.0 / (1.0 + 0.01 * (rh - 50));
}

function round2(v) { return Math.round(v * 100) / 100; }

// Отладочный лог — не чаще 1 раза в секунду
var _dbgLastMs = 0;
function dbg(msg) {
  if (!DEBUG_MODE) return;
  var now = Date.now();
  if (now - _dbgLastMs < 1000) return;
  _dbgLastMs = now;
  log("[DBG engine_detector] " + msg);
}

// ═══════════════════════════════════════════════════════
// ГЛАВНЫЙ ЦИКЛ
// ═══════════════════════════════════════════════════════

setInterval(function() {

  // 1. Комбинированные значения из двух датчиков
  var co2   = maxOf(raw.co2_a, raw.co2_b);
  var voc   = maxOf(raw.voc_a, raw.voc_b);
  var sound = maxOf(raw.snd_a, raw.snd_b);
  var temp  = avgOf(raw.tmp_a, raw.tmp_b);
  var hum   = avgOf(raw.hum_a, raw.hum_b);

  // 2. Базовая линия обновляется только пока тревога неактивна —
  //    выхлоп не должен стать новой «нормой»
  if (!alarm.alertActive) {
    ringPush(rings.co2,   co2);
    ringPush(rings.voc,   voc);
    ringPush(rings.sound, sound);
    ringPush(rings.temp,  temp);
  }

  // 3. Прогресс прогрева
  var minCount = Math.min(
    rings.co2.count, rings.voc.count,
    rings.sound.count, rings.temp.count
  );
  var baseReady = minCount >= MIN_SAMPLES;

  dev["engine_detector/BaseReady"]   = baseReady;
  dev["engine_detector/SampleCount"] = minCount;

  if (!baseReady) {
    dbg("warmup: " + minCount + "/" + MIN_SAMPLES);
    return;
  }

  // 4. Нормализованные отклонения
  var d_co2   = deltaV(rings.co2,   co2);
  var d_voc   = deltaV(rings.voc,   voc);
  var d_sound = deltaV(rings.sound, sound);
  var d_temp  = deltaV(rings.temp,  temp);

  // 5. Влажностная коррекция + CDS
  var H   = humidityCorrection(hum);
  var cds = round2((W_CO2 * d_co2 + W_VOC * d_voc + W_SOUND * d_sound + W_TEMP * d_temp) * H);

  dev["engine_detector/CDS"]         = cds;
  dev["engine_detector/CO2_delta"]   = round2(d_co2);
  dev["engine_detector/VOC_delta"]   = round2(d_voc);
  dev["engine_detector/Sound_delta"] = round2(d_sound);
  dev["engine_detector/Temp_delta"]  = round2(d_temp);

  dbg("CDS=" + cds +
      " co2=" + co2 + "(d=" + round2(d_co2) + ")" +
      " voc=" + voc + "(d=" + round2(d_voc) + ")" +
      " snd=" + round2(sound) + "(d=" + round2(d_sound) + ")" +
      " H=" + round2(H) +
      " alert=" + alarm.alertActive +
      " confirmCnt=" + alarm.confirmCount +
      " resetCnt=" + alarm.resetCount);

  // 6. Пороговая логика с гистерезисом
  if (cds >= T_CONFIRM) {
    alarm.confirmCount++;
    alarm.resetCount = 0;
  } else if (cds >= T_ALERT) {
    alarm.confirmCount = 0;
    alarm.resetCount   = 0;
  } else if (cds < T_RESET) {
    alarm.resetCount++;
    alarm.confirmCount = 0;
  } else {
    // T_RESET ≤ CDS < T_ALERT — нейтральная зона, счётчики не меняем
  }

  // Устойчивое подтверждение
  if (alarm.confirmCount >= CONFIRM_POLLS && !alarm.confirmActive) {
    alarm.confirmActive = true;
    log("ENGINE CONFIRMED: CDS=" + cds +
        " CO2d=" + round2(d_co2) +
        " VOCd=" + round2(d_voc) +
        " Sd="   + round2(d_sound) +
        " Td="   + round2(d_temp));
  }

  // Быстрая тревога (первое пересечение T_ALERT)
  if (cds >= T_ALERT && !alarm.alertActive) {
    alarm.alertActive = true;
    alarm.lastAlertTs = new Date().toISOString();
    dev["engine_detector/LastAlert"] = alarm.lastAlertTs;
    log("ENGINE ALERT: CDS=" + cds + " at " + alarm.lastAlertTs);
  }

  // Сброс тревоги — только после RESET_POLLS подряд ниже T_RESET
  if (alarm.alertActive && alarm.resetCount >= RESET_POLLS) {
    log("ENGINE cleared: CDS=" + cds +
        " (< T_RESET=" + T_RESET + " за " + RESET_POLLS + " опроса)");
    alarm.alertActive   = false;
    alarm.confirmActive = false;
    alarm.confirmCount  = 0;
    alarm.resetCount    = 0;
  }

  dev["engine_detector/Alert"]     = alarm.alertActive;
  dev["engine_detector/Confirmed"] = alarm.confirmActive;

}, POLL_MS);
