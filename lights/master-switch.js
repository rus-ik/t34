// master-switch.js — мастер-выключатель света (контроллер 192.168.0.200)
//
// По нажатию любой из «мастер-клавиш» выключает ВЕСЬ свет в доме:
//   1) гасит все реле освещения на этом контроллере;
//   2) инкрементирует /devices/t34-master/controls/last_off — этот топик
//      mosquitto-bridge пробрасывает на 192.168.0.189, где аналогичный
//      скрипт master-switch-2.js гасит реле второго контроллера.
//
// В web-UI появляется устройство «Мастер-выключатель» с кнопкой
// «Выключить весь свет» — действует так же, как физическая клавиша.
//
// ВНИМАНИЕ: автоматика движения (auto-lights-ctrl1/ctrl2) может снова
// включить свет при первом же срабатывании датчика. Если уезжаете надолго —
// отключайте home_lights_c1/enabled и home_lights_c2/enabled.

(function () {

var VDEV = "t34-master";

defineVirtualDevice(VDEV, {
  title: "Мастер-выключатель",
  cells: {
    last_off:    { type: "value",      value: 0,  readonly: true, title: "Счётчик выключений" },
    pressed_at:  { type: "text",       value: "", readonly: true, title: "Последнее срабатывание" },
    cmd_all_off: { type: "pushbutton",                            title: "Выключить весь свет" },
  },
});

// Все реле освещения, физически подключённые к .200
var RELAYS = [
  "wb-mr6cu_21/K1", "wb-mr6cu_21/K3", "wb-mr6cu_21/K4", "wb-mr6cu_21/K5", "wb-mr6cu_21/K6",
  "wb-mr6cu_26/K1", "wb-mr6cu_26/K2", "wb-mr6cu_26/K3", "wb-mr6cu_26/K4", "wb-mr6cu_26/K5", "wb-mr6cu_26/K6",
  "wb-mr6cu_43/K1", "wb-mr6cu_43/K2", "wb-mr6cu_43/K3", "wb-mr6cu_43/K4", "wb-mr6cu_43/K5",
  "wb-mr6cu_44/K2", "wb-mr6cu_44/K4", "wb-mr6cu_44/K6",
  "wb-mr6cu_54/K1", "wb-mr6cu_54/K2", "wb-mr6cu_54/K3", "wb-mr6cu_54/K5", "wb-mr6cu_54/K6",
  "wb-mr6cu_78/K2", "wb-mr6cu_78/K4", "wb-mr6cu_78/K5", "wb-mr6cu_78/K6",
  "wb-mr6cu_91/K1", "wb-mr6cu_91/K2", "wb-mr6cu_91/K4",
  "wb-mr6cu_107/K2",
];

// Физические клавиши мастер-выключателя (GPIO .200)
var SWITCHES = [
  "wb-gpio/EXT4_IN4",     // Д-B3-2   — справа от входной двери, 4-я клавиша
  // "wb-gpio/EXT2_IN12", // 1ГР-B1-4 — на выходе из гаража в прихожую (физически не подключён)
  // "wb-gpio/EXT2_IN7",  // 1ГР-B2-4 — на выходе из гаража в коридор   (физически не подключён)
];

function isPressed(v) { return v === true || v === 1; }

function pad(n) { return n < 10 ? "0" + n : "" + n; }
function fmtNow() {
  var d = new Date();
  return pad(d.getDate()) + "." + pad(d.getMonth() + 1) + " " +
         pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
}

function allOff(reason) {
  var off = 0;
  for (var i = 0; i < RELAYS.length; i++) {
    if (dev[RELAYS[i]]) { dev[RELAYS[i]] = false; off++; }
  }
  var n = (dev[VDEV + "/last_off"] | 0) + 1;
  dev[VDEV + "/last_off"]   = n;
  dev[VDEV + "/pressed_at"] = fmtNow();
  log.info("[master] all-off #" + n + " (" + reason + "), погашено реле: " + off);
}

for (var i = 0; i < SWITCHES.length; i++) {
  (function (sw, idx) {
    defineRule("master-sw-" + idx, {
      whenChanged: sw,
      then: function (v) { if (isPressed(v)) allOff(sw); },
    });
  })(SWITCHES[i], i);
}

defineRule("master-cmd-all-off", {
  whenChanged: VDEV + "/cmd_all_off",
  then: function () { allOff("UI"); },
});

})();
