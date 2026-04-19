// Door state virtual device + Telegram notifications + file log
// Deploy to: /etc/wb-rules/doors_telegram.js

var cfg      = readConfig("/etc/wb-rules-modules/doors.conf");
var TG       = cfg.telegram;
var LOG_FILE = cfg.log_file;
var DOORS    = cfg.doors;

// ── Logging ───────────────────────────────────────────────────────────────

function logDoor(doorName, state) {
  var ts  = new Date().toISOString().replace("T", " ").slice(0, 19);
  var line = ts + " | " + state + " | " + doorName;
  spawn("sh", ["-c", "echo \"$LINE\" >> \"$FILE\""], function() {}, {
    env: { LINE: line, FILE: LOG_FILE }
  });
}

// ── Telegram ──────────────────────────────────────────────────────────────

function sendTelegram(text) {
  spawn(TG.send_script, [TG.token, TG.chat_id, text], function(exitCode) {
    if (exitCode !== 0) {
      log("Telegram send error, exit: " + exitCode);
    }
  });
}

// ── Виртуальное устройство ────────────────────────────────────────────────

var vCells = {};
DOORS.forEach(function(d) {
  vCells[d.ctrl] = { type: "switch", value: false, readonly: true };
});

defineVirtualDevice("doors", {
  title: "Двери",
  cells: vCells
});

// ── Правила ───────────────────────────────────────────────────────────────

function isOpen(value, nc) {
  var v = parseInt(value, 10);
  return nc ? (v === 1) : (v === 0);
}

DOORS.forEach(function(door) {
  var parts    = door.source.split("/");
  var deviceId = parts[0];
  var channel  = parts[1];

  defineRule("door_" + door.source.replace(/[^a-z0-9]/gi, "_"), {
    whenChanged: "/devices/" + deviceId + "/controls/" + channel,
    then: function(newValue) {
      var open  = isOpen(newValue, door.nc);
      var state = open ? "ОТКРЫТА" : "закрыта";
      var icon  = open ? "\uD83D\uDEAA" : "\u2705";

      dev["doors"][door.ctrl] = open;

      logDoor(door.tg, state);

      if (door.notify) {
        sendTelegram(icon + " " + door.tg + "\n" + state);
      }
    }
  });
});
