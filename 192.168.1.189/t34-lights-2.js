// t34-lights-2.js — Привязка выключателей света к реле (контроллер 192.168.1.189)
//
// maketoggle(name, switchTopic, relayTopic):
//   На фронт нажатия (newValue=true) инвертирует состояние реле.
//   Если relayTopic пустой — клавиша «не подключена» (рулу не создаём).
//
// defineScene(name, switchTopic, relays):
//   На фронт нажатия выводит ВСЕ реле в одно состояние:
//   если хотя бы одно ВКЛ → все ВЫКЛ; если все ВЫКЛ → все ВКЛ.
//   Применяется к группам типа «весь свет на кухне».

(function() {

function isPressed(v) { return v === true || v === 1; }

function maketoggle(name, switchTopic, relayTopic) {
  if (!relayTopic) return; // клавиша не подключена
  defineRule(name, {
    whenChanged: switchTopic,
    then: function(v) {
      if (!isPressed(v)) return;
      dev[relayTopic] = !dev[relayTopic];
    },
  });
}

function defineScene(name, switchTopic, relays) {
  defineRule(name, {
    whenChanged: switchTopic,
    then: function(v) {
      if (!isPressed(v)) return;
      var anyOn = false;
      for (var i = 0; i < relays.length; i++) {
        if (dev[relays[i]]) { anyOn = true; break; }
      }
      var target = !anyOn;
      for (var j = 0; j < relays.length; j++) {
        dev[relays[j]] = target;
      }
    },
  });
}

// ══════════════════════════════════════════════════════════════════
// GPIO выключатели
// ══════════════════════════════════════════════════════════════════

// 1 этаж — Выключатель справа от выхода из кухни в коридор
maketoggle("1K-B1-1", "wb-gpio/EXT1_IN10", "wb-mr6cu_86/K1"); // 1ая клавиша — свет1 на кухне
maketoggle("1K-B1-2", "wb-gpio/EXT1_IN9",  "wb-mr6cu_86/K2"); // 2ая клавиша — свет2 на кухне

// 1 этаж — Выключатель слева от входа в буфет
maketoggle("1K-B2-1", "wb-gpio/EXT1_IN8", "wb-mr6cu_86/K1"); // 1ая клавиша — свет1 на кухне
maketoggle("1K-B2-2", "wb-gpio/EXT1_IN7", "wb-mr6cu_16/K5"); // 2ая клавиша — свет в буфете

// 1 этаж — Выключатель справа от входа в санузел 1 этаж
maketoggle("1KB-B1-1", "wb-gpio/EXT1_IN1", "wb-mr6cu_16/K1"); // 1ая клавиша — свет в санузле
maketoggle("1KB-B1-2", "wb-gpio/EXT1_IN2", "wb-mr6cu_16/K2"); // 2ая клавиша — свет в санузле

// 1 этаж — Выключатель слева от выхода из кухни на террасу
maketoggle("Д-B2-1", "wb-gpio/EXT1_IN4", "wb-mr6cu_86/K1"); // 1ая клавиша — свет1 на кухне
maketoggle("Д-B2-2", "wb-gpio/EXT1_IN6", "wb-mr6cu_16/K4"); // 2ая клавиша — свет снаружи над выходом из кухни на террасу

// 1 этаж — Выключатель справа от выхода из тех.комнаты на террасу
maketoggle("Д-B1", "wb-gpio/EXT1_IN3", "wb-mr6cu_16/K3"); // 1ая клавиша — свет снаружи над выходом из техкомнаты на террасу

})();
