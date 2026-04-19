// engine_detector.js — wb-rules скрипт
// Детекция запуска двигателя в гараже через WB-MSW4
// Загрузить в: /etc/wb-rules/engine_detector.js

// ═══════════════════════════════════════════════════════
// НАСТРОЙКИ — изменяйте только этот блок
// ═══════════════════════════════════════════════════════

var DEVICE_ID    = "wb-msw4_14";   // ID датчика в системе
var POLL_MS      = 3000;           // период опроса, мс (не менее 3000)
var BASELINE_N   = 200;            // глубина базовой линии (200 × 3с = 10 мин)
var MIN_SAMPLES  = 20;             // минимум отсчётов перед первой детекцией

var T_ALERT      = 2.0;            // порог быстрой тревоги (CDS >= 2.0)
var T_CONFIRM    = 3.5;            // порог подтверждения   (CDS >= 3.5)

// Веса параметров (сумма должна быть 1.0)
var W_CO2   = 0.35;
var W_VOC   = 0.30;
var W_SOUND = 0.25;
var W_TEMP  = 0.10;

// ═══════════════════════════════════════════════════════
// ТОПИКИ WB-MSW4 (каналы могут отличаться — проверьте)
// ═══════════════════════════════════════════════════════

var T_CO2   = "/devices/" + DEVICE_ID + "/controls/CO2";
var T_VOC   = "/devices/" + DEVICE_ID + "/controls/VOC";
var T_SOUND = "/devices/" + DEVICE_ID + "/controls/Sound Level";
var T_TEMP  = "/devices/" + DEVICE_ID + "/controls/Temperature";
var T_HUM   = "/devices/" + DEVICE_ID + "/controls/Humidity";

// ═══════════════════════════════════════════════════════
// КОЛЬЦЕВОЙ БУФЕР — хранит историю без splice/shift
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
  if (r.count < 5) return 1.0;           // мало данных — не штрафуем
  var v = 0;
  for (var i = 0; i < r.count; i++) {
    var d = r.buf[i] - mean;
    v += d * d;
  }
  var sigma = Math.sqrt(v / r.count);
  return sigma < 0.5 ? 0.5 : sigma;     // нижний клип: не делим на ~0
}

// ═══════════════════════════════════════════════════════
// СОСТОЯНИЕ
// ═══════════════════════════════════════════════════════

var state = {
  co2:   { ring: makeRing(BASELINE_N), cur: 0 },
  voc:   { ring: makeRing(BASELINE_N), cur: 0 },
  sound: { ring: makeRing(BASELINE_N), cur: 0 },
  temp:  { ring: makeRing(BASELINE_N), cur: 0 },
  hum:   0,
  alertActive:   false,
  confirmActive: false
};

// ═══════════════════════════════════════════════════════
// ВИРТУАЛЬНОЕ УСТРОЙСТВО — появится в интерфейсе WB
// ═══════════════════════════════════════════════════════

defineVirtualDevice("engine_detector", {
  title: "Engine Detector (гараж)",
  cells: {
    CDS:          { type: "value",  value: 0,     title: "CDS score"        },
    Alert:        { type: "switch", value: false,  title: "Тревога (быстро)" },
    Confirmed:    { type: "switch", value: false,  title: "Подтверждено"     },
    BaseReady:    { type: "switch", value: false,  title: "База готова"      },
    CO2_delta:    { type: "value",  value: 0,      title: "CO2 delta σ"      },
    VOC_delta:    { type: "value",  value: 0,      title: "VOC delta σ"      },
    Sound_delta:  { type: "value",  value: 0,      title: "Sound delta σ"    },
    Temp_delta:   { type: "value",  value: 0,      title: "Temp delta σ"     }
  }
});

// ═══════════════════════════════════════════════════════
// ПОДПИСКИ — обновляем текущие значения по мере прихода
// ═══════════════════════════════════════════════════════

defineRule("msw4_co2", {
  whenChanged: T_CO2,
  then: function(newValue) { state.co2.cur = parseFloat(newValue) || 0; }
});

defineRule("msw4_voc", {
  whenChanged: T_VOC,
  then: function(newValue) { state.voc.cur = parseFloat(newValue) || 0; }
});

defineRule("msw4_sound", {
  whenChanged: T_SOUND,
  then: function(newValue) { state.sound.cur = parseFloat(newValue) || 0; }
});

defineRule("msw4_temp", {
  whenChanged: T_TEMP,
  then: function(newValue) { state.temp.cur = parseFloat(newValue) || 0; }
});

defineRule("msw4_hum", {
  whenChanged: T_HUM,
  then: function(newValue) { state.hum = parseFloat(newValue) || 50; }
});

// ═══════════════════════════════════════════════════════
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ═══════════════════════════════════════════════════════

// Влажностный корректор: при высокой влажности CO2/VOC завышаются
function humidityCorrection(rh) {
  if (rh <= 50) return 1.0;
  return 1.0 / (1.0 + 0.01 * (rh - 50));
}

// Нормализованное отклонение одного параметра
function delta(s) {
  var mean  = ringMean(s.ring);
  var sigma = ringSigma(s.ring, mean);
  var d = (s.cur - mean) / sigma;
  return d > 0 ? d : 0;  // только положительные отклонения
}

// Округление до 2 знаков
function round2(v) { return Math.round(v * 100) / 100; }

// ═══════════════════════════════════════════════════════
// ГЛАВНЫЙ ЦИКЛ — запускается каждые POLL_MS
// ═══════════════════════════════════════════════════════

setInterval(function() {

  // 1. Заталкиваем текущие значения в кольцевые буферы (базовая линия)
  ringPush(state.co2.ring,   state.co2.cur);
  ringPush(state.voc.ring,   state.voc.cur);
  ringPush(state.sound.ring, state.sound.cur);
  ringPush(state.temp.ring,  state.temp.cur);

  // 2. Ждём достаточного набора базовой линии
  var minCount = Math.min(
    state.co2.ring.count, state.voc.ring.count,
    state.sound.ring.count, state.temp.ring.count
  );

  var baseReady = minCount >= MIN_SAMPLES;
  dev["engine_detector"]["BaseReady"] = baseReady;

  if (!baseReady) return;  // накапливаем — не детектируем

  // 3. Вычисляем нормализованные отклонения
  var d_co2   = delta(state.co2);
  var d_voc   = delta(state.voc);
  var d_sound = delta(state.sound);
  var d_temp  = delta(state.temp);

  // 4. Влажностная коррекция
  var H = humidityCorrection(state.hum);

  // 5. Комбинированное взвешенное отклонение (CDS)
  var cds = (W_CO2 * d_co2 + W_VOC * d_voc + W_SOUND * d_sound + W_TEMP * d_temp) * H;
  cds = round2(cds);

  // 6. Публикуем компоненты для диагностики
  dev["engine_detector"]["CDS"]         = cds;
  dev["engine_detector"]["CO2_delta"]   = round2(d_co2);
  dev["engine_detector"]["VOC_delta"]   = round2(d_voc);
  dev["engine_detector"]["Sound_delta"] = round2(d_sound);
  dev["engine_detector"]["Temp_delta"]  = round2(d_temp);

  // 7. Пороговая логика
  if (cds >= T_CONFIRM) {
    if (!state.confirmActive) {
      state.confirmActive = true;
      log("ENGINE CONFIRMED: CDS=" + cds +
          " CO2d=" + round2(d_co2) +
          " VOCd=" + round2(d_voc) +
          " Sd=" + round2(d_sound) +
          " Td=" + round2(d_temp));
    }
    dev["engine_detector"]["Confirmed"] = true;
    dev["engine_detector"]["Alert"]     = true;
    state.alertActive = true;

  } else if (cds >= T_ALERT) {
    if (!state.alertActive) {
      state.alertActive = true;
      log("ENGINE ALERT: CDS=" + cds);
    }
    dev["engine_detector"]["Alert"]     = true;
    dev["engine_detector"]["Confirmed"] = false;
    state.confirmActive = false;

  } else {
    // CDS ниже обоих порогов — сброс тревоги
    if (state.alertActive) {
      log("ENGINE alert cleared: CDS=" + cds);
    }
    state.alertActive   = false;
    state.confirmActive = false;
    dev["engine_detector"]["Alert"]     = false;
    dev["engine_detector"]["Confirmed"] = false;
  }

}, POLL_MS);
