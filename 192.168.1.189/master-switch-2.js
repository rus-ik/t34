// master-switch-2.js — мастер-выключатель света (контроллер 192.168.0.189)
//
// Слушает /devices/t34-master/controls/last_off, который publish'ит мастер-скрипт
// на 192.168.0.200; топик пробрасывается через mosquitto-bridge (см.
// mosquitto/bridge-189.conf на .200). При каждом инкременте счётчика гасит
// все реле освещения на этом контроллере.
//
// ВНИМАНИЕ: автоматика движения (auto-lights-ctrl2) может снова включить
// свет при первом же срабатывании датчика — для длительного отъезда
// отключайте home_lights_c2/enabled.

(function () {

var TRIGGER = "t34-master/last_off";

// Все реле освещения, физически подключённые к .189
var RELAYS = [
  "wb-mr6cu_86/K1", "wb-mr6cu_86/K2",
  "wb-mr6cu_16/K1", "wb-mr6cu_16/K2", "wb-mr6cu_16/K3", "wb-mr6cu_16/K4", "wb-mr6cu_16/K5",
];

var lastSeen = null;

defineRule("master-listener", {
  whenChanged: TRIGGER,
  then: function (v) {
    if (v === undefined || v === null || v === "") return;
    // Первое значение после рестарта — запоминаем, но не реагируем,
    // чтобы не гасить свет на старте wb-rules.
    if (lastSeen === null) { lastSeen = v; return; }
    if (v === lastSeen) return;
    lastSeen = v;

    var off = 0;
    for (var i = 0; i < RELAYS.length; i++) {
      if (dev[RELAYS[i]]) { dev[RELAYS[i]] = false; off++; }
    }
    log.info("[master/189] all-off #" + v + ", погашено реле: " + off);
  },
});

})();
