// ================================================================
// garage.js  –  Garage & Car Gate Lighting + Two-Slot Car Detection
// Wiren Board wb-rules engine (Duktape / ECMAScript 5)
//
// External hardware map: /etc/wb-rules/devices.conf  (JSON)
//
// Features:
//   [1]  Startup state sync       – seeds lightsOn from actual relay state
//   [2]  readConfig guard         – try/catch with clear error log
//   [3]  IIFE isolation           – no variable leaks on hot-reload
//   [4]  PIR exact-expiry timer   – setTimeout per sensor, no polling cron
//   [5]  Lux hysteresis           – separate ON/OFF thresholds
//   [6]  Atomic timer cancel      – cancelAllTimers() helper
//   [7]  Virtual status device    – per-zone + per-slot cells in web UI
//   [8]  Structured logging       – [ZONE:x][TRIGGER:y] grep-friendly
//   [9]  Sensor error counter     – undefined reads tracked + shown in vdev
//   [10] CONFIG in devices.conf   – all timing lives in the hardware map
//   [11] Per-zone config          – zone-level overrides of global config
//   [12] Input polarity flag      – invertLogic per door
//   [13] Watchdog heartbeat       – 60 s cron pulse + CO2 spike age refresh
//   [14] Max-on hard cap          – absolute ceiling regardless of sensors
//   [15] Two-slot car detection   – shared CO2 latch + independent per-slot
//          LiDAR distance (WT53R-485), gate relay, confirm window, cooldown
//   [16] Astronomical night clock  – external gate lights on only between sunset/sunrise
//          (Khabarovsk coords from devices.conf); isNight initialised on startup
//   [17] Telegram notifications   – gate auto-open (pulseGate) + gate close (reed switch)
//          with live CO2/LiDAR snapshot; bot token/chatId in devices.conf
// ================================================================

(function () { // [3] IIFE

// ── Load hardware map ──────────────────────────────────────────────
var hw; // [2]
try {
  hw = readConfig("/etc/wb-rules-modules/devices.conf");
} catch (e) {
  log.error("[GARAGE] FATAL: cannot load devices.conf – " + e);
  return;
}

var GCFG = hw.config;
var TG   = hw.telegram || null; // [17] Telegram bot config (optional)

// ── Config resolver ────────────────────────────────────────────────
// Local key → global fallback; used for both zones [11] and slots [15]
function cfg(def, key) {
  return def.hasOwnProperty(key) ? def[key] : GCFG[key];
}

// ── Build helpers ──────────────────────────────────────────────────
function mcmInput(moduleName, inputName, invertLogic) { // [12]
  var d = hw.mcm[moduleName];
  var obj = { device: d.id, input: d.inputs[inputName], invertLogic: !!invertLogic };
  obj.topic = obj.device + "/Input " + obj.input;
  return obj;
}

function mr6cChannel(moduleName, channelName) {
  var d = hw.mr6c[moduleName];
  return { topic: d.id + "/K" + d.channels[channelName] };
}

function buildZone(name, def) {
  var i, arr, doors = [], mtd = [], msw = [], lights = [];

  arr = def.mcmDoors || [];
  for (i = 0; i < arr.length; i++) doors.push(mcmInput(arr[i][0], arr[i][1], arr[i][2]));

  arr = def.mtdSensors || [];
  for (i = 0; i < arr.length; i++) mtd.push(hw.mtd[arr[i]].id);

  arr = def.mswSensors || [];
  for (i = 0; i < arr.length; i++) msw.push(hw.msw[arr[i]].id);

  arr = def.mr6cLights || [];
  for (i = 0; i < arr.length; i++) lights.push(mr6cChannel(arr[i][0], arr[i][1]));

  var slug = name.replace(/\s+/g, "_").toLowerCase();

  // Pre-compute sensor read topics – avoids string concat in hot path [perf]
  var mtdLuxTopics = [], mtdPresTopics = [], mswLuxTopics = [];
  for (i = 0; i < mtd.length; i++) {
    mtdLuxTopics.push(mtd[i]  + "/Illuminance status");
    mtdPresTopics.push(mtd[i] + "/Presence Status");
  }
  for (i = 0; i < msw.length; i++) {
    mswLuxTopics.push(msw[i] + "/Illuminance");
  }


  // Pre-compute all runtime config values – eliminates cfg() calls in hot path [perf]
  var autoOffMin = cfg(def, "autoOffMin");
  var zoneCfg = {
    pirWindowMs:        cfg(def, "pirWindowSec") * 1000,
    autoOffEnabled:     autoOffMin > 0,
    autoOffMs:          autoOffMin * 60 * 1000,
    presenceOffDelayMs: cfg(def, "presenceOffDelaySec") * 1000,
    luxThresholdOff:    cfg(def, "luxThresholdOff"),
    luxThresholdOn:     cfg(def, "luxThresholdOn"),
    maxOnMs:            cfg(def, "maxOnHours") * 3600 * 1000,
    maxOnLabel:         cfg(def, "maxOnHours") + "h",
  };

  // [16] Astro-mode zones use gateExternalLightMin as their auto-off duration
  if (def.astroMode) {
    zoneCfg.autoOffEnabled = true;
    zoneCfg.autoOffMs      = cfg(def, "gateExternalLightMin") * 60 * 1000;
  }

  // Pre-compute full vdev cell paths – eliminates slug-concat + vset overhead [perf]
  var vdev = {
    lights:   "garage_status/" + slug + "_lights",
    occupied: "garage_status/" + slug + "_occupied",
    lux:      "garage_status/" + slug + "_lux",
    trigger:  "garage_status/" + slug + "_trigger",
  };

  return {
    name: name, slug: slug,
    doors: doors, mtd: mtd, msw: msw, lights: lights,
    mtdLuxTopics: mtdLuxTopics, mtdPresTopics: mtdPresTopics, mswLuxTopics: mswLuxTopics,
    cfg: zoneCfg, vdev: vdev,
    astroMode: !!def.astroMode,  // [16]
  };
}

// ── Zones ──────────────────────────────────────────────────────────
var ZONES = [];
var zonesKeys = Object.keys(hw.zones);
for (var zi = 0; zi < zonesKeys.length; zi++) {
  var zKey = zonesKeys[zi];
  var label = zKey.replace(/([A-Z])/g, " $1")
                  .replace(/^./, function (c) { return c.toUpperCase(); });
  ZONES.push(buildZone(label, hw.zones[zKey]));
}

// ── Topic helpers ──────────────────────────────────────────────────
var GLOBAL_LUX = hw.msw[Object.keys(hw.msw)[0]].id + "/Illuminance";

// Pre-compute per-zone lux topic lists (needs GLOBAL_LUX, so done after zones) [perf]
for (var lti = 0; lti < ZONES.length; lti++) {
  var ltz = ZONES[lti];
  ltz.luxTopics = ltz.mtdLuxTopics.concat(ltz.mswLuxTopics);
  if (ltz.luxTopics.length === 0) ltz.luxTopics = [GLOBAL_LUX];
}

// Pre-computed constant vdev paths used across multiple functions
var DEV_TEST_MODE     = "garage_status/test_mode";
var DEV_ERRORS        = "garage_status/errors";
var DEV_WATCHDOG      = "garage_status/watchdog";
var DEV_CO2_PPM       = "garage_status/co2_ppm";
var DEV_CO2_SPIKE     = "garage_status/co2_spike";
var DEV_CO2_SPIKE_AGE = "garage_status/co2_spike_age";
var DEV_IS_NIGHT      = "garage_status/is_night";  // [16]

// Debug flag – string construction is skipped entirely when false  [perf]
var DEBUG_ENABLED = true;

// ── Structured logger ──────────────────────────────────────────────  [8]
function logInfo(ctx, trigger, msg) {
  log.info("[" + ctx + "][TRIGGER:" + trigger + "] " + msg);
}
function logDebug(ctx, trigger, msg) {
  log.debug("[" + ctx + "][TRIGGER:" + trigger + "] " + msg);
}

// ── Virtual status device ──────────────────────────────────────────  [7]
var vdevCells = {
  test_mode: { type: "switch", value: false, title: "Test Mode (bypass lux)"       },
  watchdog:  { type: "text",   value: "",    title: "Watchdog last heartbeat"       },
  errors:    { type: "value",  value: 0,     title: "Sensor read errors"            },
  is_night:  { type: "switch", value: false, title: "Night mode (astronomical clock)" }, // [16]
  // Shared CO2 state
  co2_ppm:       { type: "value",  value: 0,     title: "CO2: Highest reading (ppm)" },
  co2_spike:     { type: "switch", value: false,  title: "CO2: Spike latched"         },
  co2_spike_age: { type: "value",  value: 0,      title: "CO2: Spike age (sec)"       },
};

// Per-zone lighting cells
for (var vi = 0; vi < ZONES.length; vi++) {
  var vz = ZONES[vi], vs = vz.slug;
  vdevCells[vs + "_lights"]   = { type: "switch", value: false, title: vz.name + ": Lights"        };
  vdevCells[vs + "_occupied"] = { type: "switch", value: false, title: vz.name + ": Occupied"      };
  vdevCells[vs + "_lux"]      = { type: "value",  value: 0,     title: vz.name + ": Avg Lux"       };
  vdevCells[vs + "_trigger"]  = { type: "text",   value: "",    title: vz.name + ": Last trigger"  };
}

// Per-slot car detection cells
hw.carSlots.forEach(function (slot, i) {
  var s = "slot" + (i + 1);
  vdevCells[s + "_distance_m"]  = { type: "value",  value: 0,    title: slot.name + ": Distance (m)"      };
  vdevCells[s + "_car_present"] = { type: "switch", value: false, title: slot.name + ": Car present"       };
  vdevCells[s + "_gate_enable"] = { type: "switch", value: true,  title: slot.name + ": Auto-gate enabled" };
  vdevCells[s + "_cooldown"]    = { type: "switch", value: false, title: slot.name + ": Cooldown active"   };
  vdevCells[s + "_last_open"]   = { type: "text",   value: "",    title: slot.name + ": Last gate open"    };
});

defineVirtualDevice("garage_status", { title: "Garage Automation", cells: vdevCells });


// ── Runtime state – lighting ───────────────────────────────────────
var zst = {};
for (var si = 0; si < ZONES.length; si++) {
  var zone = ZONES[si];
  var pirIds = zone.msw.slice();           // pre-computed for cancelAllTimers [perf]
  var pirTimers = {}, pirLastSeen = {};
  for (var pi = 0; pi < pirIds.length; pi++) {
    pirLastSeen[pirIds[pi]] = 0;
    pirTimers[pirIds[pi]]   = null;
  }
  zst[si] = {
    lightsOn:     false,
    autoOffTimer: null,
    maxOnTimer:   null,   // [14]
    vacantTimer:  null,
    pirIds:       pirIds,      // [4] stable array – no Object.keys() at runtime
    pirTimers:    pirTimers,
    pirLastSeen:  pirLastSeen,
    sensorErrors: 0,           // [9]
  };
}

// ── Runtime state – astronomical night flag ────────────────────────  [16]
var isNight = false; // updated by Sunrise/Sunset rules; initialised below

// Simplified NOAA sunrise/sunset formula, accuracy ±15 min – sufficient for lighting.
// Returns true when the current UTC moment is between sunset and sunrise.
function initNightState(lat, lon) {
  var now    = new Date();
  var jan1   = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
  var day    = Math.round((now - jan1) / 86400000) + 1;
  var decl   = 23.45 * Math.sin((360 / 365 * (day - 81)) * Math.PI / 180) * Math.PI / 180;
  var latR   = lat * Math.PI / 180;
  var cosHA  = -Math.tan(latR) * Math.tan(decl);
  if (cosHA >= 1)  return true;   // polar night
  if (cosHA <= -1) return false;  // polar day
  var ha     = Math.acos(cosHA) * 180 / Math.PI;
  var lonOff = lon / 15;
  var srUTC  = 12 - ha / 15 - lonOff;
  var ssUTC  = 12 + ha / 15 - lonOff;
  var nowH   = now.getUTCHours() + now.getUTCMinutes() / 60;
  return nowH < srUTC || nowH > ssUTC;
}

// ── Runtime state – car detection ──────────────────────────────────  [15]
//
// co2State  – SHARED across all slots (one engine fills the whole garage)
// slotState – one entry per carSlot, fully independent
var co2State = {
  spikeAt:  0,   // ms timestamp when CO2 first crossed threshold (0 = not latched)
  spikePpm: 0,   // ppm value that caused the latch
};

var slotState = hw.carSlots.map(function () {
  return { cooldownTimer: null, gateOffTimer: null, inCooldown: false };
});

// ── [1] Startup state sync ─────────────────────────────────────────
for (var ssi = 0; ssi < ZONES.length; ssi++) {
  var ssZone = ZONES[ssi];
  var anyOn = false;
  for (var li = 0; li < ssZone.lights.length; li++) {
    var lv = dev[ssZone.lights[li].topic];
    if (lv === true || lv === 1) { anyOn = true; break; }
  }
  zst[ssi].lightsOn = anyOn;
  dev[ssZone.vdev.lights] = anyOn;
  if (anyOn) logInfo("ZONE:" + ssZone.name, "startup", "Relay was ON – state synced");
}

// ── [16] Astronomical night state – initialise on startup ──────────
isNight = initNightState(GCFG.latitude, GCFG.longitude);
dev[DEV_IS_NIGHT] = isNight;
logInfo("ASTRO", "startup", "isNight=" + isNight +
  " (lat=" + GCFG.latitude + " lon=" + GCFG.longitude + ")");

// ── Lux helpers ────────────────────────────────────────────────────
var totalErrors = 0;

// Uses pre-computed topic arrays and accumulator instead of push+reduce [perf]
function getZoneLux(zone, idx) {
  var sum = 0, count = 0, v, i, topics;

  topics = zone.mtdLuxTopics;
  for (i = 0; i < topics.length; i++) {
    v = dev[topics[i]];
    if (v !== undefined && v !== null) { sum += Number(v); count++; }
    else { zst[idx].sensorErrors++; totalErrors++; }        // [9]
  }
  if (count > 0) return sum / count;

  topics = zone.mswLuxTopics;
  for (i = 0; i < topics.length; i++) {
    v = dev[topics[i]];
    if (v !== undefined && v !== null) { sum += Number(v); count++; }
    else { zst[idx].sensorErrors++; totalErrors++; }        // [9]
  }
  if (count > 0) return sum / count;

  v = dev[GLOBAL_LUX];
  return (v !== undefined && v !== null) ? Number(v) : 999;
}

// isDark takes pre-computed lux and uses pre-computed thresholds [5][perf]
function isDark(lux, zone, idx) {
  if (dev[DEV_TEST_MODE]) {
    logInfo("ZONE:" + zone.name, "lux",
      "[TEST MODE] lux check bypassed (avg=" + lux.toFixed(1) + ")");
    return true;
  }
  return lux < (zst[idx].lightsOn ? zone.cfg.luxThresholdOff : zone.cfg.luxThresholdOn);
}


// ── Telegram notifications ─────────────────────────────────────────  [17]
//
// tgSend(text) – passes an arbitrary multi-line message to send_tg.sh via
// $'...' ANSI-C quoting so that newlines survive the sh boundary cleanly.
// The function is a no-op when TG config is absent or botToken is empty.
//
// All message text is built from numeric sensor values and fixed strings,
// so the only chars that need escaping are \, ' and actual newline.

function tgSend(text) {
  if (!TG || !TG.botToken || !TG.chatId || !TG.scriptPath) return;
  var escaped = text
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/\n/g, "\\n");
  runShellCommand(
    "bash '" + TG.scriptPath + "'" +
    " '" + TG.botToken + "'" +
    " '" + TG.chatId   + "'" +
    " $'" + escaped + "'" +
    " > /dev/null 2>&1 &"
  );
}

// Returns a multi-line string with live readings from all CO2 + LiDAR sensors.
function tgSensorSnapshot() {
  var lines = [];
  var i, v, n;
  for (i = 0; i < co2Topics.length; i++) {
    v = dev[co2Topics[i]];
    n = (v !== undefined && v !== null) ? Number(v).toFixed(0) : "н/д";
    lines.push("CO2[" + (i + 1) + "]: " + n + " ppm");
  }
  for (i = 0; i < carSlots.length; i++) {
    v = dev[carSlots[i].distanceTopic];
    var dm = (v !== undefined && v !== null) ? Number(v) : 999;
    lines.push("Слот " + (i + 1) + ": " + (dm < 900 ? dm.toFixed(2) + " м" : "н/д"));
  }
  return lines.join("\n");
}

function tgGateOpen(slot) {
  var v = dev[slot.distanceTopic];
  var distM  = (v !== undefined && v !== null) ? Number(v) : 999;
  var distStr = distM < 900 ? distM.toFixed(2) + " м" : "н/д";
  var ageS   = co2State.spikeAt > 0
    ? Math.round((Date.now() - co2State.spikeAt) / 1000) : 0;
  var msg =
    "[ГАРАЖ] Открытие ворот\n" +
    "Слот: " + slot.name + "\n" +
    "Триггеры: CO2 пик=" + co2State.spikePpm + " ppm, дист=" + distStr +
      ", возраст сигнала=" + ageS + " с\n" +
    "--- датчики ---\n" +
    tgSensorSnapshot() + "\n" +
    new Date().toISOString();
  tgSend(msg);
}

function tgGateClose(slot) {
  var co2Cur  = readBestCo2();
  var spikeInfo = co2State.spikeAt > 0
    ? "пик был " + co2State.spikePpm + " ppm" : "нет";
  var msg =
    "[ГАРАЖ] Ворота закрыты\n" +
    "Слот: " + slot.name + "\n" +
    "CO2: " + co2Cur + " ppm (" + spikeInfo + ")\n" +
    "--- датчики ---\n" +
    tgSensorSnapshot() + "\n" +
    new Date().toISOString();
  tgSend(msg);
}

// ── Occupancy helpers ──────────────────────────────────────────────
// for-loops with early return – avoids closure allocation per call [perf]
function isAnyDoorOpen(zone) {                              // [12]
  var doors = zone.doors, raw, bit, i;
  for (i = 0; i < doors.length; i++) {
    raw = dev[doors[i].topic];
    bit = (raw === true || raw === 1) ? 1 : 0;
    if (doors[i].invertLogic ? (bit === 0) : (bit === 1)) return true;
  }
  return false;
}
function isAnyMtdPresent(zone) {
  var topics = zone.mtdPresTopics, v, i;
  for (i = 0; i < topics.length; i++) {
    v = dev[topics[i]];
    if (v === true || v === 1) return true;
  }
  return false;
}
function isAnyPirFresh(zone, idx) {
  var msw = zone.msw, pls = zst[idx].pirLastSeen, i; // cache pirLastSeen [perf]
  for (i = 0; i < msw.length; i++) {
    if (pls[msw[i]] > 0) return true;
  }
  return false;
}
function isOccupied(zone, idx) {
  return isAnyMtdPresent(zone) || isAnyPirFresh(zone, idx);
}

// ── Timer helpers ──────────────────────────────────────────────────
function cancelTimer(idx, key) {
  var st = zst[idx];
  if (st[key]) { clearTimeout(st[key]); st[key] = null; }
}
function cancelAllTimers(idx) {                             // [6][14]
  var st = zst[idx];                                       // single lookup [perf]
  if (st.autoOffTimer) { clearTimeout(st.autoOffTimer); st.autoOffTimer = null; }
  if (st.vacantTimer)  { clearTimeout(st.vacantTimer);  st.vacantTimer  = null; }
  if (st.maxOnTimer)   { clearTimeout(st.maxOnTimer);   st.maxOnTimer   = null; }
  var ids = st.pirIds;                                      // [4] pre-computed, no alloc [perf]
  for (var pi = 0; pi < ids.length; pi++) {
    if (st.pirTimers[ids[pi]]) { clearTimeout(st.pirTimers[ids[pi]]); st.pirTimers[ids[pi]] = null; }
    st.pirLastSeen[ids[pi]] = 0;
  }
}

function armPirTimer(zone, idx, sensorId) {                 // [4]
  var st = zst[idx];                                       // single lookup [perf]
  if (st.pirTimers[sensorId]) clearTimeout(st.pirTimers[sensorId]);
  st.pirTimers[sensorId] = setTimeout(function () {
    st.pirTimers[sensorId]   = null;
    st.pirLastSeen[sensorId] = 0;
    if (DEBUG_ENABLED) logDebug("ZONE:" + zone.name, "pir-expire", "PIR window expired: " + sensorId);
    evaluate(zone, idx, "pir-expire:" + sensorId);
  }, zone.cfg.pirWindowMs);
}

// ── Light control ──────────────────────────────────────────────────
// knownLux: lux already read by caller (evaluate); pass undefined from timers
function setLights(zone, idx, on, trigger, knownLux) {
  var st     = zst[idx];
  var lights = zone.lights, i;

  // Detect manual relay change since last script write: compare cached state
  // against the actual relay topic (changed by parallel wall switch).        [1]
  var actualOn = false;
  for (i = 0; i < lights.length; i++) {
    var rv = dev[lights[i].topic];
    if (rv === true || rv === 1) { actualOn = true; break; }
  }
  if (actualOn !== st.lightsOn) {
    logInfo("ZONE:" + zone.name, trigger,
      "Manual override: relay=" + actualOn + " cached=" + st.lightsOn + " – syncing");
    st.lightsOn            = actualOn;
    dev[zone.vdev.lights]  = actualOn;
    // Trying to auto-off a light that was manually turned ON → abort.
    if (actualOn && !on) return;
    // Light manually turned OFF while cached as ON → sync done; fall through
    // to normal turn-on logic if on=true, or return if on=false.
    if (!on) return;
  }

  if (st.lightsOn === on) return;
  var lux = (knownLux !== undefined) ? knownLux : getZoneLux(zone, idx); // avoid double read [perf]
  logInfo("ZONE:" + zone.name, trigger,
    "Lights " + (on ? "ON" : "OFF") +
    " [LUX:" + lux.toFixed(1) + "]" +
    " [TEST:" + !!dev[DEV_TEST_MODE] + "]");
  for (i = 0; i < lights.length; i++) dev[lights[i].topic] = on;
  st.lightsOn            = on;
  dev[zone.vdev.lights]  = on;
  dev[zone.vdev.trigger] = trigger;
}

function armMaxOnTimer(zone, idx) {                         // [14]
  if (zst[idx].maxOnTimer) clearTimeout(zst[idx].maxOnTimer);
  zst[idx].maxOnTimer = setTimeout(function () {
    zst[idx].maxOnTimer = null;
    logInfo("ZONE:" + zone.name, "max-on-cap",
      "Forced OFF after " + zone.cfg.maxOnLabel + " cap"); // pre-computed [perf]
    cancelAllTimers(idx);
    setLights(zone, idx, false, "max-on-cap");
  }, zone.cfg.maxOnMs);                                     // pre-computed [perf]
}

function scheduleAutoOff(zone, idx) {
  cancelTimer(idx, "autoOffTimer");
  if (!zone.cfg.autoOffEnabled) return;                     // pre-computed [perf]
  zst[idx].autoOffTimer = setTimeout(function () {
    zst[idx].autoOffTimer = null;
    if (!isOccupied(zone, idx) && !isAnyDoorOpen(zone)) {
      cancelAllTimers(idx);
      setLights(zone, idx, false, "auto-off");
    } else {
      scheduleAutoOff(zone, idx); // still active – reset
    }
  }, zone.cfg.autoOffMs);                                   // pre-computed [perf]
}

// ── Core zone evaluator ────────────────────────────────────────────
function evaluate(zone, idx, trigger) {
  var lux;
  // [16] Astro-mode zones (external gate lights): only gate movement triggers.
  //      isNight (astronomical) is the primary gate; lux inside the garage is
  //      checked as a twilight proxy – indoor illuminance is a function of outdoor
  //      light, so during dusk/dawn the lux threshold catches residual daylight
  //      that pure sunset/sunrise timing would miss.
  if (zone.astroMode) {
    dev[zone.vdev.occupied] = isNight;
    if (isNight) {
      lux = getZoneLux(zone, idx);
      dev[zone.vdev.lux] = lux;
      if (lux < zone.cfg.luxThresholdOn) {          // dark enough – turn on [5][perf]
        setLights(zone, idx, true, trigger, lux);
        scheduleAutoOff(zone, idx);                 // resets timer on every gate event
      } else if (DEBUG_ENABLED) {
        logDebug("ZONE:" + zone.name, trigger,
          "isNight but lux=" + lux.toFixed(1) + " >= " + zone.cfg.luxThresholdOn + " – skip");
      }
    }
    return;
  }

  var st       = zst[idx];             // single lookup – used ~8 times below [perf]
  var doorOpen = isAnyDoorOpen(zone);
  var mtd      = isAnyMtdPresent(zone);
  var pir      = isAnyPirFresh(zone, idx);
  var active   = doorOpen || mtd || pir;
  lux          = getZoneLux(zone, idx); // single read; passed to isDark + setLights [perf]
  var dark     = isDark(lux, zone, idx);
  var vdev     = zone.vdev;

  dev[vdev.lux]      = lux;
  dev[vdev.occupied] = active;

  if (DEBUG_ENABLED) {                 // skip string build when debug is off [perf]
    logDebug("ZONE:" + zone.name, trigger,
      "[DOOR:" + doorOpen + "][MTD:" + mtd + "][PIR:" + pir +
      "][LUX:" + lux.toFixed(1) + "][DARK:" + dark + "][ON:" + st.lightsOn + "]");
  }

  if (active && dark) {
    if (st.vacantTimer) { clearTimeout(st.vacantTimer); st.vacantTimer = null; }
    if (!st.lightsOn) {
      setLights(zone, idx, true, trigger, lux);            // pass lux – no re-read [perf]
      armMaxOnTimer(zone, idx);                             // [14]
    }
    scheduleAutoOff(zone, idx);

  } else if (!active) {
    if (st.lightsOn && st.vacantTimer === null) {
      st.vacantTimer = setTimeout(function () {
        st.vacantTimer = null;
        if (!isOccupied(zone, idx) && !isAnyDoorOpen(zone)) {
          cancelAllTimers(idx);
          setLights(zone, idx, false, "vacant-confirmed");
        }
      }, zone.cfg.presenceOffDelayMs);
    }

  } else {
    // active but lux above threshold – do NOT force off while presence is detected.
    // The sensor reads reflected artificial light, so lux is only reliable as a
    // gate for the ON decision; vacancy/auto-off timers handle the OFF path.  [5]
    if (!st.lightsOn) {
      scheduleAutoOff(zone, idx); // already on via manual switch – keep auto-off armed
    }
  }
}

// ================================================================
// CAR DETECTION – shared CO2 latch + per-slot ceiling distance  [15]
//
// State machine (per slot, runs independently):
//
//   IDLE
//     │─── CO2 latch SET  AND  distance < carDistanceMax
//     │    AND spike age ≤ slot co2ConfirmWindowSec
//     ▼
//   GATE PULSED
//     │─── gateOpenPulseSec later: relay OFF
//     │─── gateReopenCooldownMin later: IDLE
//     ▼
//   COOLDOWN
//
// CO2 latch resets when reading drops below co2BaselinePpm.
// Each slot reads its OWN co2ConfirmWindowSec and
// gateReopenCooldownMin from devices.conf via cfg().
// ================================================================

// ── Build CO2 sensor id list + pre-compute read topics ────────────
var co2SensorIds = [], co2Topics = [];
var mswKeys = Object.keys(hw.msw);
for (var ci = 0; ci < mswKeys.length; ci++) {
  if (hw.msw[mswKeys[ci]].co2Sensor) {
    var cid = hw.msw[mswKeys[ci]].id;
    co2SensorIds.push(cid);
    co2Topics.push(cid + "/CO2");      // pre-computed [perf]
  }
}

// ── Build per-slot objects ─────────────────────────────────────────
var carSlots = hw.carSlots.map(function (slotDef, i) {
  var sk      = "slot" + (i + 1);
  if (!hw.lidar) {
    log.error("[GARAGE] devices.conf: секция 'lidar' отсутствует");
    throw new Error("devices.conf missing 'lidar' section");
  }
  if (!hw.lidar[slotDef.lidarSensor]) {
    log.error("[GARAGE] devices.conf: lidar['" + slotDef.lidarSensor + "'] не найден (слот " + sk + ")");
    throw new Error("devices.conf missing lidar key: " + slotDef.lidarSensor);
  }
  var distId  = hw.lidar[slotDef.lidarSensor].id;
  var wSec    = cfg(slotDef, "co2ConfirmWindowSec");

  // Pre-compute all runtime config values                         [perf]
  var slotCfg = {
    carDistanceMax: cfg(slotDef, "carDistanceMax"),
    windowMs:       wSec * 1000,
    windowSec:      wSec,
    gateOpenMs:     cfg(slotDef, "gateOpenPulseSec") * 1000,
    cooldownMs:     cfg(slotDef, "gateReopenCooldownMin") * 60 * 1000,
  };

  // Pre-compute full vdev paths                                   [perf]
  var vdev = {
    distance:    "garage_status/" + sk + "_distance_m",
    carPresent:  "garage_status/" + sk + "_car_present",
    gateEnable:  "garage_status/" + sk + "_gate_enable",
    cooldown:    "garage_status/" + sk + "_cooldown",
    lastOpen:    "garage_status/" + sk + "_last_open",
  };

  // Gate close reed topic for Telegram notification                   [17]
  var reedTopic = null;
  if (slotDef.gateReedSensor) {
    var rm  = slotDef.gateReedSensor;
    var rmd = hw.mcm[rm[0]];
    reedTopic = rmd.id + "/Input " + rmd.inputs[rm[1]]; // pre-computed [perf]
  }

  return {
    name:          slotDef.name,
    idx:           i,
    distanceTopic: distId + "/Distance", // pre-computed [perf]
    gateRelayTopic: mr6cChannel(slotDef.gateTriggerRelay[0], slotDef.gateTriggerRelay[1]).topic, // pre-computed [perf]
    reedTopic: reedTopic,                // pre-computed [17]
    cfg:  slotCfg,
    vdev: vdev,
  };
});

// ── Read helpers ───────────────────────────────────────────────────
function readBestCo2() {
  var best = 0, v, n, i;
  for (i = 0; i < co2Topics.length; i++) {    // for-loop + pre-computed topics [perf]
    v = dev[co2Topics[i]];
    if (v !== undefined && v !== null) {
      n = Number(v);
      if (n > best) best = n;
    }
  }
  return best;
}

// ── Update shared CO2 vdev cells ──────────────────────────────────
function updateCo2Vdev() {
  // DEV_CO2_PPM is written once at the top of evaluateCo2 – no repeat here [perf]
  var latched = co2State.spikeAt > 0;
  dev[DEV_CO2_SPIKE]     = latched;
  dev[DEV_CO2_SPIKE_AGE] = latched
    ? Math.round((Date.now() - co2State.spikeAt) / 1000) : 0;
}

// ── Gate pulse for one slot ────────────────────────────────────────
function pulseGate(slot, reason) {
  var st   = slotState[slot.idx];
  var vdev = slot.vdev;

  if (st.inCooldown) {
    logInfo("CAR:" + slot.name, "blocked", "Cooldown active – gate suppressed");
    return;
  }
  if (!dev[vdev.gateEnable]) {             // pre-computed path [perf]
    logInfo("CAR:" + slot.name, "blocked", "Auto-gate disabled in UI");
    return;
  }

  var ts = new Date().toISOString();
  logInfo("CAR:" + slot.name, "gate-pulse", "Opening gate – " + reason + " at " + ts);
  dev[vdev.lastOpen] = ts + " – " + reason; // pre-computed path [perf]
  tgGateOpen(slot);                         // [17] notify Telegram

  var gateRelayTopic = slot.gateRelayTopic;
  dev[gateRelayTopic] = true;

  if (st.gateOffTimer) clearTimeout(st.gateOffTimer);
  st.gateOffTimer = setTimeout(function () {
    st.gateOffTimer = null;
    dev[gateRelayTopic] = false;
    logInfo("CAR:" + slot.name, "gate-release", "Gate relay released");
  }, slot.cfg.gateOpenMs);                 // pre-computed [perf]

  // Enter cooldown (per-slot duration)                    [15]
  st.inCooldown = true;
  dev[vdev.cooldown] = true;               // pre-computed path [perf]
  if (st.cooldownTimer) clearTimeout(st.cooldownTimer);
  st.cooldownTimer = setTimeout(function () {
    st.cooldownTimer = null;
    st.inCooldown    = false;
    dev[vdev.cooldown] = false;
    logInfo("CAR:" + slot.name, "cooldown-end", "Detection re-armed");
  }, slot.cfg.cooldownMs);                 // pre-computed [perf]
}

// ── Per-slot evaluator ─────────────────────────────────────────────
//
// Called on CO2 update OR when this slot's distance sensor changes.
// Uses pre-computed slot.cfg instead of cfg() calls.             [15][perf]
function evaluateSlot(slot, trigger) {
  var st   = slotState[slot.idx];
  var vdev = slot.vdev;
  var v    = dev[slot.distanceTopic];      // pre-computed topic [perf]
  var distM      = (v !== undefined && v !== null) ? Number(v) : 999;
  var carPresent = distM < slot.cfg.carDistanceMax; // pre-computed [perf]

  dev[vdev.distance]   = distM;           // pre-computed path [perf]
  dev[vdev.carPresent] = carPresent;

  if (DEBUG_ENABLED) {
    logDebug("CAR:" + slot.name, trigger,
      "[DIST:" + distM.toFixed(2) + "m]" +
      "[CAR:" + carPresent + "]" +
      "[CO2_LATCHED:" + (co2State.spikeAt > 0) + "]" +
      "[SPIKE_PPM:" + co2State.spikePpm + "]" +
      "[COOLDOWN:" + st.inCooldown + "]");
  }

  if (st.inCooldown)           return;
  if (!carPresent)             return;
  if (co2State.spikeAt === 0)  return; // CO2 spike not yet seen

  // Check spike is still within THIS slot's confirm window          [15]
  var spikeAgeMs = Date.now() - co2State.spikeAt;
  var windowMs   = slot.cfg.windowMs;     // pre-computed [perf]

  if (spikeAgeMs <= windowMs) {
    pulseGate(slot,
      "CO2=" + co2State.spikePpm + "ppm" +
      " dist=" + distM.toFixed(2) + "m" +
      " age=" + Math.round(spikeAgeMs / 1000) + "s");
  } else if (DEBUG_ENABLED) {
    logDebug("CAR:" + slot.name, trigger,
      "CO2 spike too old for this slot (" +
      Math.round(spikeAgeMs / 1000) + "s > " +
      slot.cfg.windowSec + "s) – not triggering"); // pre-computed [perf]
  }
}

// ── Shared CO2 latch evaluator ─────────────────────────────────────
//
// Called on every CO2 sensor change.
// Updates the global latch, then re-evaluates ALL slots.
// Does NOT expire the latch itself – each slot decides independently
// whether the spike is still fresh enough for its own confirm window.
// Latch resets only when CO2 drops below co2BaselinePpm.
function evaluateCo2(trigger) {
  var ppm = readBestCo2();
  dev[DEV_CO2_PPM] = ppm; // always reflect current reading in UI

  // CO2 below baseline → reset latch
  if (ppm > 0 && ppm < GCFG.co2BaselinePpm) {
    if (co2State.spikeAt > 0) {
      logInfo("CAR:CO2", trigger,
        "CO2 below baseline (" + ppm + " ppm) – spike latch reset");
      co2State.spikeAt  = 0;
      co2State.spikePpm = 0;
      updateCo2Vdev(); // single write after state change
    }
    return;
  }

  // CO2 above spike threshold → latch or update peak
  if (ppm >= GCFG.co2SpikeThreshold) {
    if (co2State.spikeAt === 0) {
      co2State.spikeAt  = Date.now();
      co2State.spikePpm = ppm;
      updateCo2Vdev();
      logInfo("CAR:CO2", trigger,
        "Spike latched: " + ppm + " ppm at " +
        new Date(co2State.spikeAt).toISOString());
    } else if (ppm > co2State.spikePpm) {
      co2State.spikePpm = ppm; // track peak while spike is active
      updateCo2Vdev();
    }

    // Re-evaluate all slots – each uses its own confirm window      [15]
    for (var i = 0; i < carSlots.length; i++) { // for-loop [perf]
      evaluateSlot(carSlots[i], "co2-update");
    }
  }
}

// ================================================================
// RULES
// ================================================================

// ── Door inputs ────────────────────────────────────────────────────
ZONES.forEach(function (zone, idx) {
  zone.doors.forEach(function (door) {
    defineRule("door_" + idx + "_" + door.device + "_in" + door.input, {
      whenChanged: door.topic,
      then: function () { evaluate(zone, idx, "door"); },
    });
  });
});

// ── MTD presence (lighting) ────────────────────────────────────────
ZONES.forEach(function (zone, idx) {
  zone.mtd.forEach(function (id) {
    defineRule("mtd_pres_" + idx + "_" + id.replace(/\W/g, "_"), {
      whenChanged: id + "/Presence Status",
      then: function () { evaluate(zone, idx, "mtd:" + id); },
    });
  });
});

// ── WB-MSW-v4 PIR motion (lighting) ───────────────────────────────
ZONES.forEach(function (zone, idx) {
  zone.msw.forEach(function (id) {
    defineRule("msw_pir_" + idx + "_" + id.replace(/\W/g, "_"), {
      whenChanged: id + "/Current Motion",
      then: function (newValue) {
        if (newValue > 0) {
          zst[idx].pirLastSeen[id] = Date.now();
          armPirTimer(zone, idx, id);                       // [4]
          evaluate(zone, idx, "pir:" + id);
        }
      },
    });
  });
});

// ── Illuminance (lighting) ─────────────────────────────────────────
var luxTopicMap = {};
ZONES.forEach(function (zone, idx) {
  if (zone.astroMode) return; // lux is read on demand at gate event; no subscription needed
  zone.luxTopics.forEach(function (topic) {
    if (!luxTopicMap[topic]) luxTopicMap[topic] = [];
    if (luxTopicMap[topic].indexOf(idx) === -1) luxTopicMap[topic].push(idx);
  });
});
Object.keys(luxTopicMap).forEach(function (topic) {
  defineRule("lux_" + topic.replace(/\W/g, "_"), {
    whenChanged: topic,
    then: function () {
      var zones = luxTopicMap[topic];
      for (var i = 0; i < zones.length; i++) { // for-loop [perf]
        evaluate(ZONES[zones[i]], zones[i], "lux");
      }
    },
  });
});

// ── CO2 changes → shared latch → all slots re-evaluated ───────────
co2SensorIds.forEach(function (id) {
  defineRule("co2_" + id.replace(/\W/g, "_"), {
    whenChanged: id + "/CO2",
    then: function () { evaluateCo2("co2:" + id); },
  });
});

// ── Per-slot ceiling distance → that slot only ─────────────────────
carSlots.forEach(function (slot) {
  defineRule("dist_" + slot.idx + "_" + slot.distanceTopic.replace(/\W/g, "_"), {
    whenChanged: slot.distanceTopic,
    then: function () { evaluateSlot(slot, "distance"); },
  });
});

// ── Gate close via reed switch → Telegram notification ────────────  [17]
// invertLogic=false for all carGate reeds: value 0/false = gate physically closed.
carSlots.forEach(function (slot) {
  if (!slot.reedTopic) return;
  defineRule("gate_close_tg_" + slot.idx, {
    whenChanged: slot.reedTopic,
    then: function (newValue) {
      if (!(newValue === true || newValue === 1)) { // 0/false → gate closed
        logInfo("CAR:" + slot.name, "gate-close", "Reed closed – notifying Telegram");
        tgGateClose(slot);
      }
    },
  });
});

// ── Astronomical clock – cron every minute ────────────────────────  [16]
// Sunrise/Sunset built-ins are unavailable in this wb-rules version;
// reuse the NOAA initNightState() already used at startup.
defineRule("astronomical_clock", {
  when: function () { return cron("0 * * * * *"); },
  then: function () {
    var nowNight = initNightState(GCFG.latitude, GCFG.longitude);
    if (nowNight === isNight) return;
    isNight = nowNight;
    dev[DEV_IS_NIGHT] = isNight;
    if (isNight) {
      logInfo("ASTRO", "cron", "Night mode ON (sunset)");
    } else {
      logInfo("ASTRO", "cron", "Night mode OFF (sunrise)");
      for (var i = 0; i < ZONES.length; i++) {
        if (ZONES[i].astroMode) setLights(ZONES[i], i, false, "sunrise");
      }
    }
  },
});

// ── Test mode toggle ───────────────────────────────────────────────
defineRule("test_mode_changed", {
  whenChanged: DEV_TEST_MODE,
  then: function (newValue) {
    logInfo("ALL", "test-mode", newValue ? "ENABLED" : "DISABLED");
    ZONES.forEach(function (zone, idx) { evaluate(zone, idx, "test-mode"); });
  },
});

// ── Watchdog heartbeat (60 s) ──────────────────────────────────────  [13]
defineRule("garage_watchdog", {
  when: function () { return cron("0 * * * * *"); },
  then: function () {
    var ts = new Date().toISOString();
    dev[DEV_WATCHDOG] = ts;            // pre-computed path [perf]
    dev[DEV_ERRORS]   = totalErrors;
    // Keep co2_spike_age fresh between CO2 readings
    if (co2State.spikeAt > 0) {
      dev[DEV_CO2_SPIKE_AGE] = Math.round((Date.now() - co2State.spikeAt) / 1000);
    }
    log.debug("[GARAGE][WATCHDOG] alive=" + ts + " errors=" + totalErrors);
  },
});

log.info("[GARAGE] Script loaded" +
  " | zones: "       + ZONES.map(function (z) {
      return z.name + (z.astroMode ? "[ASTRO]" : "");
    }).join(", ") +
  " | isNight: "     + isNight +
  " | CO2 sensors: " + co2SensorIds.join(", ") +
  " | car slots: "   + carSlots.map(function (s) {
      return s.name +
             " [LiDAR:" + s.distanceTopic +
             " window:" + s.cfg.windowSec + "s" +
             " cooldown:" + (s.cfg.cooldownMs / 60000) + "min]";
    }).join(", "));

})(); // end IIFE
