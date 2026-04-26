//var t34devices = require('t34-all-devices');

function maketoggle(name, light_switch, relay_control) {
    defineRule(name, {
        whenChanged: light_switch,
        then: function (newValue, devName, cellName) {
            if (newValue == true && dev[relay_control] == false) {
                dev[relay_control] = true;
            } else if (newValue == true && dev[relay_control] == true) {
                dev[relay_control] = false;
            }
        }
    });
}

// Привязка выключателей света к реле
//maketoggle("1T-B1", t34devices.EXT1_3, t34devices.R26 + "/K3");

// Выключатель справа от выхода из кухни в коридор
maketoggle("1K-B1-1", "wb-gpio/EXT1_IN10", "wb-mr6cu_86/K1"); // 1ая клавиша - свет1 на кухне
maketoggle("1K-B1-2", "wb-gpio/EXT1_IN9", "wb-mr6cu_86/K2"); // 2ая клавиша - свет2 на кухне

// Выключатель слева от входа в буфет
maketoggle("1K-B2-1", "wb-gpio/EXT1_IN8", "wb-mr6cu_86/K1"); // 1ая клавиша - свет1 на кухне
maketoggle("1K-B2-2", "wb-gpio/EXT1_IN7", "wb-mr6cu_16/K5"); // 2ая клавиша - свет в буфете

// Выключатель справа от входа в санузел 1 этаж
maketoggle("1KB-B1-1", "wb-gpio/EXT1_IN1", "wb-mr6cu_16/K1"); // 1ая клавиша - свет в санузле
maketoggle("1KB-B1-2", "wb-gpio/EXT1_IN2", "wb-mr6cu_16/K2"); // 1ая клавиша - свет в санузле

// Выключатель слева от выхода из кухни на террасу
maketoggle("Д-B2-1", "wb-gpio/EXT1_IN4", "wb-mr6cu_86/K1"); // 1ая клавиша - свет1 на кухне
maketoggle("Д-B2-2", "wb-gpio/EXT1_IN6", "wb-mr6cu_16/K4"); // 2ая клавиша - свет снаружи над выходом из кухни на террасу

// Выключатель справа от выхода из тех.комнаты на террасу
maketoggle("Д-B1", "wb-gpio/EXT1_IN3", "wb-mr6cu_16/K3"); // 1ая клавиша - свет снаружи над выходом из техкомнаты на террасу
