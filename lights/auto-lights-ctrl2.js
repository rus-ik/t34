// Auto lighting — контроллер 2 (192.168.1.189), 1 этаж
//
// MTDX62-MB (ctrl2): 10(1П) 26(1К) 25(1КБТемная) 33(1КБСветлая) 32(1КМ) 27(1Г) 21(1ГД) 24(1ГС) 23(1Т) 28(1СА)
// WB-MSW (ctrl1, доступны через общий MQTT): v3_149(1К) v3_1+v3_157(1КБ) v3_151(1ГС) v4_116(1Т)
// Реле ctrl2: wb-mr6cu_86(1К), wb-mr6cu_16(1СА)
//
// Тестовый режим: home_lights_c2/test_mode → освещённость игнорируется
// Ночной режим: 22:00–07:00 → освещённость не проверяется
// Звук: только запрещает выключение (не включает свет)

var lib = require('auto-lights-lib');

lib.createController({
  pfx:           "[C2]",
  vdev:          "home_lights_c2",
  title:         "Свет авто — 1 эт.",
  rulePfx:       "c2",
  chMtdPresence: "presence_status",  // прошивка ctrl2 — lowercase
  chMtdLux:      "illuminance",

  rooms: [
    {
      id: "1П", slug: "r_1p", name: "Прихожая",
      sensors: [],
      mtd: ["mtdx62-mb_10"],
      lights: ["wb-mr6cu_43/K1", "wb-mr6cu_21/K5"],
      linkedRooms: [],
      pirWindowSec: 60, presenceDelaySec: 90, autoOffMin: 15,
      luxOn: 15, luxOff: 50,
    },
    {
      id: "1КБТемная", slug: "r_1kb_t", name: "Большой коридор (тёмная)",
      sensors: [{ dev: "wb-msw-v3_1" }],
      mtd: ["mtdx62-mb_25"],
      lights: ["wb-mr6cu_26/K5"],
      linkedRooms: ["r_1p"],
      pirWindowSec: 60, presenceDelaySec: 90, autoOffMin: 20,
      luxOn: 10, luxOff: 50,
    },
    {
      id: "1КБСветлая", slug: "r_1kb_s", name: "Большой коридор (светлая)",
      sensors: [{ dev: "wb-msw-v3_157" }],
      mtd: ["mtdx62-mb_33"],
      lights: ["wb-mr6cu_26/K6"],
      linkedRooms: [],
      pirWindowSec: 60, presenceDelaySec: 90, autoOffMin: 20,
      luxOn: 15, luxOff: 50,
    },
    {
      id: "1КМ", slug: "r_1km", name: "Малый коридор",
      sensors: [],
      mtd: ["mtdx62-mb_32"],
      lights: ["wb-mr6cu_26/K4"],
      linkedRooms: [],
      pirWindowSec: 60, presenceDelaySec: 180, autoOffMin: 15,
      luxOn: 10, luxOff: 50,
    },
    {
      id: "1Г", slug: "r_1g", name: "Гостиная",
      sensors: [],
      mtd: ["mtdx62-mb_27"],
      lights: ["wb-mr6cu_21/K1"],
      linkedRooms: [],
      pirWindowSec: 180, presenceDelaySec: 300, autoOffMin: 60,
      luxOn: 15, luxOff: 50,
    },
    {
      id: "1ГД", slug: "r_1gd", name: "Гардероб 1 эт.",
      sensors: [],
      mtd: ["mtdx62-mb_21"],
      lights: ["wb-mr6cu_44/K2"],
      linkedRooms: [],
      pirWindowSec: 90, presenceDelaySec: 120, autoOffMin: 20,
      luxOn: 15, luxOff: 80,     // гардероб без окон — всегда тёмно
    },
    {
      id: "1ГС", slug: "r_1gs", name: "Гостевая",
      sensors: [{ dev: "wb-msw-v3_151" }],
      mtd: ["mtdx62-mb_24"],
      lights: ["wb-mr6cu_26/K1", "wb-mr6cu_26/K2"],
      linkedRooms: [],
      pirWindowSec: 180, presenceDelaySec: 300, autoOffMin: 60,
      luxOn: 15, luxOff: 50,
    },
    {
      id: "1Т", slug: "r_1t", name: "Техническая комната",
      sensors: [{ dev: "wb-msw-v4_116" }],
      mtd: ["mtdx62-mb_23"],
      lights: ["wb-mr6cu_26/K3"],
      linkedRooms: [],
      pirWindowSec: 120, presenceDelaySec: 180, autoOffMin: 30,
      luxOn: 15, luxOff: 50,
    },
    {
      id: "1К", slug: "r_1k", name: "Кухня",
      sensors: [{ dev: "wb-msw-v3_149" }],
      mtd: ["mtdx62-mb_26"],
      lights: ["wb-mr6cu_86/K1", "wb-mr6cu_86/K2"],
      linkedRooms: [],
      pirWindowSec: 120, presenceDelaySec: 180, autoOffMin: 30,
      luxOn: 15, luxOff: 50,
    },
    {
      id: "1СА", slug: "r_1sa", name: "Санузел 1 эт.",
      sensors: [],
      mtd: ["mtdx62-mb_28"],
      lights: ["wb-mr6cu_16/K1", "wb-mr6cu_16/K2"],
      temporarilyOff: ["wb-mr6cu_16/K2"],
      linkedRooms: [],
      pirWindowSec: 90, presenceDelaySec: 180, autoOffMin: 30,
      luxOn: 15, luxOff: 50,
    },
  ],
});
