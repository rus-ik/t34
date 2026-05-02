// Auto lighting — контроллер 1 (192.168.0.200), 2 этаж + лестница
//
// WB-MSW (ctrl1): v3_189(2С) v4_172(2ДБ) v3_188(2ДМ) v3_198(2СД) v3_183(2СБ) v4_123(Л)
// MTDX62-MB (ctrl1): 55(2С) 22(2ДБ) 31(2ДМ) 29(2СБ)
//
// Тестовый режим: home_lights_c1/test_mode → освещённость игнорируется
// Ночной режим: 22:00–07:00 → освещённость не проверяется
// Звук: только запрещает выключение (не включает свет)
// Связанные комнаты: 2С/2ДБ/2ДМ → Л (лестница включается при движении из комнат)

var lib = require('auto-lights-lib');

lib.createController({
  pfx:           "[C1]",
  vdev:          "home_lights_c1",
  title:         "Свет авто — 2 эт.",
  rulePfx:       "c1",
  chMtdPresence: "Presence Status",    // прошивка ctrl1 — CamelCase
  chMtdLux:      "Illuminance status",

  rooms: [
    {
      id: "Л", slug: "r_l", name: "Лестница",
      sensors: [{ dev: "wb-msw-v4_123" }],
      mtd: [],
      lights: ["wb-mr6cu_91/K4", "wb-mr6cu_44/K4", "wb-mr6cu_21/K3"],
      linkedRooms: [],
      pirWindowSec: 45, presenceDelaySec: 60, autoOffMin: 10,
      luxOn: 30, luxOff: 50,
    },
    {
      id: "2С", slug: "r_2s", name: "Спальня",
      sensors: [{ dev: "wb-msw-v3_189" }],
      mtd: ["mtdx62-mb_55"],
      lights: ["wb-mr6cu_54/K2", "wb-mr6cu_54/K3"],
      linkedRooms: ["r_l"],
      pirWindowSec: 300, presenceDelaySec: 600, autoOffMin: 120,
      luxOn: 30, luxOff: 50,
    },
    {
      id: "2ДБ", slug: "r_2db", name: "Детская большая",
      sensors: [{ dev: "wb-msw-v4_172" }],
      mtd: ["mtdx62-mb_22"],
      lights: ["wb-mr6cu_91/K1", "wb-mr6cu_91/K2", "wb-mr6cu_78/K6"],
      linkedRooms: ["r_l"],
      pirWindowSec: 180, presenceDelaySec: 300, autoOffMin: 60,
      luxOn: 30, luxOff: 50,
    },
    {
      id: "2ДМ", slug: "r_2dm", name: "Детская малая",
      sensors: [{ dev: "wb-msw-v3_188" }],
      mtd: ["mtdx62-mb_31"],
      lights: ["wb-mr6cu_78/K4", "wb-mr6cu_78/K5"],
      linkedRooms: ["r_l"],
      pirWindowSec: 180, presenceDelaySec: 300, autoOffMin: 60,
      luxOn: 30, luxOff: 50,
    },
    {
      id: "2СД", slug: "r_2sd", name: "Санузел детский",
      sensors: [{ dev: "wb-msw-v3_198" }],
      mtd: [],
      lights: ["wb-mr6cu_78/K2"],
      linkedRooms: [],
      pirWindowSec: 90, presenceDelaySec: 180, autoOffMin: 20,
      luxOn: 30, luxOff: 50,
    },
    {
      id: "2СБ", slug: "r_2sb", name: "Санузел большой",
      sensors: [{ dev: "wb-msw-v3_183" }],
      mtd: ["mtdx62-mb_29"],
      lights: ["wb-mr6cu_54/K5", "wb-mr6cu_54/K6"],
      linkedRooms: [],
      pirWindowSec: 90, presenceDelaySec: 180, autoOffMin: 30,
      luxOn: 30, luxOff: 50,
    },
    // 2К (коридор 2эт, MTD slave_id=5) — реле не определено, добавить позже
  ],
});
