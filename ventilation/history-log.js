// Логирование истории изменения топиков вентиляционных устройств
//
// Устройства:
//   wb-mio-gpio_21:1   — датчик положения приводов (16-канальный DI, IN1–IN16)
//   wb-mrm2-mini_50    — N1 Сушилка
//   wb-mrm2-mini_64    — N2 Ванная
//   wb-mrm2-mini_73    — N6 Унитаз
//   wb-mrm2-mini_70    — N7 Чердак

(function () {

function ts() {
  var d = new Date();
  return d.toISOString().replace("T", " ").slice(0, 19);
}

function logChange(devName, cellName, newValue) {
  log("[HISTORY] " + ts() + "  " + devName + "/" + cellName + " = " + newValue);
}

log("[HISTORY] history-log.js loaded");

defineRule("history_mrm2", {
  whenChanged: [
    "wb-mrm2-mini_50/Input 1",
    "wb-mrm2-mini_50/Input 2",
    "wb-mrm2-mini_50/K1",
    "wb-mrm2-mini_50/K2",
    "wb-mrm2-mini_50/Curtain 1 Open",
    "wb-mrm2-mini_50/Curtain 1 Close",
    "wb-mrm2-mini_64/Input 1",
    "wb-mrm2-mini_64/Input 2",
    "wb-mrm2-mini_64/K1",
    "wb-mrm2-mini_64/K2",
    "wb-mrm2-mini_64/Curtain 1 Open",
    "wb-mrm2-mini_64/Curtain 1 Close",
    "wb-mrm2-mini_73/Input 1",
    "wb-mrm2-mini_73/Input 2",
    "wb-mrm2-mini_73/K1",
    "wb-mrm2-mini_73/K2",
    "wb-mrm2-mini_73/Curtain 1 Open",
    "wb-mrm2-mini_73/Curtain 1 Close",
    "wb-mrm2-mini_70/Input 1",
    "wb-mrm2-mini_70/Input 2",
    "wb-mrm2-mini_70/K1",
    "wb-mrm2-mini_70/K2",
    "wb-mrm2-mini_70/Curtain 1 Open",
    "wb-mrm2-mini_70/Curtain 1 Close"
  ],
  then: function (newValue, devName, cellName) {
    logChange(devName, cellName, newValue);
  }
});

defineRule("history_wbio", {
  whenChanged: [
    "wb-mio-gpio_21:1/IN1",
    "wb-mio-gpio_21:1/IN2",
    "wb-mio-gpio_21:1/IN3",
    "wb-mio-gpio_21:1/IN4",
    "wb-mio-gpio_21:1/IN5",
    "wb-mio-gpio_21:1/IN6",
    "wb-mio-gpio_21:1/IN7",
    "wb-mio-gpio_21:1/IN8",
    "wb-mio-gpio_21:1/IN9",
    "wb-mio-gpio_21:1/IN10",
    "wb-mio-gpio_21:1/IN11",
    "wb-mio-gpio_21:1/IN12",
    "wb-mio-gpio_21:1/IN13",
    "wb-mio-gpio_21:1/IN14",
    "wb-mio-gpio_21:1/IN15",
    "wb-mio-gpio_21:1/IN16"
  ],
  then: function (newValue, devName, cellName) {
    logChange(devName, cellName, newValue);
  }
});

})();
