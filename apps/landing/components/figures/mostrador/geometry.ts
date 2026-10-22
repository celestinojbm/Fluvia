/**
 * Banco de mostrador — geometría estática.
 *
 * Partes (cada una apoya en otra):
 * base: 4 bridas, 4 pies, placa, halo, ranura, 4 tornillos, regla, placa de rótulo
 * bandeja: suelo, 4 paredes, 3 fichas en reposo
 * estructura: 2 rieles, 2 topes, tornillos de tope
 * carro: placa, 4 bujes, tornillos de buje, remaches, ficha (la pieza lit), cuello, pomo moleteado
 * muelles: uno por riel, mitad lejana y mitad cercana
 * cajón del comercio: cuerpo, tapa, costura, ranura, 2 charnelas
 * cajón de crédito (cerrado, fuera de los rieles): cuerpo, pomo, tornillos
 * comparador: collar, poste, anillos, bisel, esfera, trazos, aguja, cubo, corona
 */

import {
  boxCorners,
  coil,
  corners,
  cylinder,
  depthOf,
  dotGrid,
  fitProjection,
  haloOf,
  insetPlan,
  iso,
  knurl,
  lineOnTop,
  planOutline,
  radialTicks,
  ring,
  sideArc,
  sideSeam,
  slabOf,
  topTicks,
  translateAlong,
  type Flat,
  type Plan,
  type Point3,
  type SolidPaths,
} from '../../iso/iso-kit';
import { END, HOME, SPAN } from './model';

export const WIDTH = 720;
export const HEIGHT = 460;
const AZIMUTH = 38;
const ELEVATION = 30;

export const PLATE: Plan = { x: -170, y: -74, w: 340, d: 156, r: 10 };
const FOOT_DROP = -18;

export const RAIL_X = -102;
export const RAIL_W = 204;
export const RAIL_D = 6;
const RAIL_H = 3.4;
const RAIL_BACK_Y = -18;
const RAIL_FRONT_Y = 16;

export const CARRIAGE: Plan = { x: -18, y: -24, w: 36, d: 52, r: 2.4 };
const CARRIAGE_Z = 3.4;
const CARRIAGE_H = 5;
const CARRIAGE_TOP = CARRIAGE_Z + CARRIAGE_H;

export const STOP_R: Plan = { x: 96, y: -26, w: 8, d: 56, r: 1.2 };
const STOP_L: Plan = { x: -112, y: -26, w: 8, d: 56, r: 1.2 };

const TRAY: Plan = { x: -158, y: -6, w: 42, d: 54, r: 2 };
const WALL = 3.4;
const TILL: Plan = { x: 116, y: -14, w: 44, d: 62, r: 3 };
const LID: Plan = { x: 119, y: -11, w: 38, d: 50, r: 2 };
const DRAWER: Plan = { x: -24, y: 48, w: 86, d: 22, r: 2 };
const LABEL: Plan = { x: 28, y: -66, w: 46, d: 14, r: 1.2 };
const STRIP: Plan = { x: -148, y: -68, w: 168, d: 5.2, r: 1 };

const DIAL = { x: -4, y: -56 };
const DIAL_R = 15;
const DIAL_FACE_Z = 26;
const DIAL_TOP = 26.8;
const NEEDLE_R = 10.5;
const NEEDLE_FROM = Math.PI * 1.15;
const NEEDLE_TO = Math.PI * 1.85;
const COIL_R = 2.7;
const COIL_TURNS = 8;
const COIL_Z = 5.4;

const bounds: Point3[] = [
  ...boxCorners(PLATE, FOOT_DROP, 4),
  ...boxCorners(TILL, 0, 26),
  ...boxCorners(DRAWER, 0, 16),
  [DIAL.x, DIAL.y, 36],
  [DIAL.x - DIAL_R, DIAL.y - DIAL_R, DIAL_TOP],
  [DIAL.x + DIAL_R, DIAL.y + DIAL_R, DIAL_TOP],
];

export const P = fitProjection(bounds, WIDTH, HEIGHT, {
  pad: 36,
  headroom: 8,
  azimuth: AZIMUTH,
  elevation: ELEVATION,
});

export const HOME_SCREEN = iso([HOME, 2, 12], P)[0];
export const END_SCREEN = iso([END, 2, 12], P)[0];

const byDepth = (points: Array<[number, number]>) =>
  [...points].sort((a, b) => depthOf([a[0], a[1], 0], P) - depthOf([b[0], b[1], 0], P));

function screws(points: Array<[number, number]>, z: number, radius = 2.05) {
  return {
    ring: points.map(([x, y]) => ring(x, y, radius, z, P, 14)).join(''),
    dots: points.map(([x, y]) => iso([x, y, z], P)),
  };
}

const footCenters = byDepth(corners(PLATE, 26));

const trayInner: Plan = {
  x: TRAY.x + WALL,
  y: TRAY.y + WALL,
  w: TRAY.w - WALL * 2,
  d: TRAY.d - WALL * 2,
  r: 1,
};

const farWall: Plan = { x: TRAY.x, y: TRAY.y, w: TRAY.w, d: WALL, r: 1 };
const nearWall: Plan = {
  x: TRAY.x,
  y: TRAY.y + TRAY.d - WALL,
  w: TRAY.w,
  d: WALL,
  r: 1,
};
const leftWall: Plan = { x: TRAY.x, y: TRAY.y + WALL, w: WALL, d: TRAY.d - WALL * 2, r: 0.6 };
const rightWall: Plan = {
  x: TRAY.x + TRAY.w - WALL,
  y: TRAY.y + WALL,
  w: WALL,
  d: TRAY.d - WALL * 2,
  r: 0.6,
};

const bush = (x: number, y: number): Plan => ({ x, y, w: 12, d: 10, r: 1.4 });
const BUSHES = [bush(-16, -20), bush(4, -20), bush(-16, 14), bush(4, 14)];

const coin = (cx: number, cy: number, radius: number, z: number, h: number) =>
  cylinder(cx, cy, radius, z, h, P, 28, 0.35);

const plateScrews = screws(corners(PLATE, 12), 0.15);
const labelScrews = screws(
  [
    [LABEL.x + 3.2, LABEL.y + 3.2],
    [LABEL.x + LABEL.w - 3.2, LABEL.y + LABEL.d - 3.2],
  ],
  0.95,
  1.15
);
const stopScrews = screws(
  [
    [STOP_L.x + 4, STOP_L.y + 6],
    [STOP_L.x + 4, STOP_L.y + STOP_L.d - 6],
    [STOP_R.x + 4, STOP_R.y + 6],
    [STOP_R.x + 4, STOP_R.y + STOP_R.d - 6],
  ],
  8.2,
  1.25
);
const bushScrews = screws(
  BUSHES.map((plan) => [plan.x + plan.w / 2, plan.y + plan.d / 2]),
  CARRIAGE_Z + 6.3,
  1.15
);
const drawerScrews = screws(
  [
    [DRAWER.x + 6, DRAWER.y + 6],
    [DRAWER.x + DRAWER.w - 6, DRAWER.y + 6],
  ],
  11.2,
  1.2
);

const ruler = topTicks(
  STRIP.x + 3,
  STRIP.x + STRIP.w - 3,
  8,
  5,
  STRIP.y + 0.4,
  0.75,
  [1.5, 3.2],
  P
);
const dialTicks = radialTicks(
  DIAL.x,
  DIAL.y,
  DIAL_R - 1.4,
  24,
  4,
  DIAL_TOP,
  [1.5, 2.8],
  P,
  NEEDLE_FROM - 0.15,
  NEEDLE_TO - NEEDLE_FROM + 0.3
);

const zeroAngle = NEEDLE_FROM;
const zeroTick = lineOnTop(
  [DIAL.x + Math.cos(zeroAngle) * (DIAL_R - 4.2), DIAL.y + Math.sin(zeroAngle) * (DIAL_R - 4.2)],
  [DIAL.x + Math.cos(zeroAngle) * (DIAL_R - 1.2), DIAL.y + Math.sin(zeroAngle) * (DIAL_R - 1.2)],
  DIAL_TOP,
  P
);

const labelRules = [28, 18, 22]
  .map((length, index) =>
    lineOnTop(
      [LABEL.x + 5, LABEL.y + 4.2 + index * 2.6],
      [LABEL.x + 5 + length, LABEL.y + 4.2 + index * 2.6],
      0.9,
      P
    )
  )
  .join('');

const slot: Plan = { x: LID.x + 14, y: LID.y + 8, w: 10, d: 3.2, r: 1.2 };

export interface FootArt {
  key: string;
  flange: SolidPaths;
  stem: SolidPaths;
}

export const ART = {
  halo: haloOf(PLATE, FOOT_DROP, 10, P),
  feet: footCenters.map(([x, y], index): FootArt => ({
    key: `foot-${index}`,
    flange: cylinder(x, y, 7.2, FOOT_DROP, 1.7, P, 24),
    stem: cylinder(x, y, 5.2, FOOT_DROP + 1.7, 4.3, P, 24),
  })),
  base: slabOf(PLATE, -12, 12, P, 8, 1.5),
  groove: planOutline(insetPlan(PLATE, 5.5), 0, P),
  plateScrews,
  strip: slabOf(STRIP, 0, 0.7, P, 3),
  rulerMinor: ruler.minor,
  rulerMajor: ruler.major,
  label: slabOf(LABEL, 0, 0.85, P, 4),
  labelEdge: planOutline(insetPlan(LABEL, 1.5), 0.85, P),
  labelRules,
  labelScrews,
  farWall: slabOf(farWall, 1.4, 7.2, P, 3, 0.4),
  trayFloor: slabOf(TRAY, 0, 1.4, P, 4, 0.3),
  coins: [
    coin(-146, 10, 4.6, 1.4, 1.5),
    coin(-136, 24, 3.8, 1.4, 1.5),
    coin(-147, 30, 4.1, 1.4, 1.5),
  ],
  leftWall: slabOf(leftWall, 1.4, 7.2, P, 3, 0.4),
  rightWall: slabOf(rightWall, 1.4, 7.2, P, 3, 0.4),
  nearWall: slabOf(nearWall, 1.4, 7.2, P, 3, 0.4),
  trayLip: planOutline(trayInner, 8.6, P),
  railBack: slabOf({ x: RAIL_X, y: RAIL_BACK_Y, w: RAIL_W, d: RAIL_D, r: 1 }, 0, RAIL_H, P, 3, 0.4),
  railFront: slabOf(
    { x: RAIL_X, y: RAIL_FRONT_Y, w: RAIL_W, d: RAIL_D, r: 1 },
    0,
    RAIL_H,
    P,
    3,
    0.4
  ),
  stopL: slabOf(STOP_L, 0, 8, P, 3, 0.45),
  stopR: slabOf(STOP_R, 0, 8, P, 3, 0.45),
  stopScrews,
  carriage: slabOf(CARRIAGE, CARRIAGE_Z, CARRIAGE_H, P, 4, 0.55),
  bushes: BUSHES.map((plan) => slabOf(plan, CARRIAGE_Z, 6.2, P, 3, 0.35)),
  bushScrews,
  rivets: dotGrid(CARRIAGE.x + 5, CARRIAGE.y + CARRIAGE.d - 2.4, 6, 1, 4.6, CARRIAGE_TOP, P),
  token: cylinder(0, 2, 7.1, CARRIAGE_TOP, 2.7, P, 32, 0.45),
  tokenRim: ring(0, 2, 5.4, CARRIAGE_TOP + 2.7, P, 32),
  neck: slabOf({ x: -5, y: 12, w: 10, d: 8, r: 1.2 }, CARRIAGE_TOP, 1.6, P, 3, 0.3),
  knob: cylinder(0, 17.5, 4.8, CARRIAGE_TOP + 1.6, 5.4, P, 28, 0.35),
  knurl: knurl(0, 17.5, 4.8, CARRIAGE_TOP + 1.8, CARRIAGE_TOP + 6.6, 22, P),
  pointer: lineOnTop([-2.2, 17.5], [3.4, 17.5], CARRIAGE_TOP + 7.05, P),
  till: slabOf(TILL, 0, 20, P, 5, 0.8),
  tillSeam: sideSeam(TILL, 10, P, 5),
  lid: slabOf(LID, 20, 3, P, 4, 0.45),
  slot: planOutline(slot, 23, P),
  hinges: [cylinder(122, -8, 1.6, 20, 3.2, P, 16), cylinder(154, -8, 1.6, 20, 3.2, P, 16)],
  drawer: slabOf(DRAWER, 0, 11, P, 4, 0.5),
  pull: cylinder(DRAWER.x + DRAWER.w / 2, DRAWER.y + 13, 3.6, 11, 4.6, P, 24, 0.3),
  pullKnurl: knurl(DRAWER.x + DRAWER.w / 2, DRAWER.y + 13, 3.6, 11.3, 15.2, 16, P),
  drawerScrews,
  collar: cylinder(DIAL.x, DIAL.y, 5.4, 0, 3.2, P, 24),
  post: cylinder(DIAL.x, DIAL.y, 3.3, 3.2, 18.6, P, 24),
  postSeamA: sideArc(DIAL.x, DIAL.y, 3.3, 9, P, 16),
  postSeamB: sideArc(DIAL.x, DIAL.y, 3.3, 16, P, 16),
  bezel: cylinder(DIAL.x, DIAL.y, DIAL_R, 21.8, 4.2, P, 36, 0.4),
  face: cylinder(DIAL.x, DIAL.y, DIAL_R - 1.7, DIAL_FACE_Z, 0.8, P, 36),
  dialTicksMinor: dialTicks.minor,
  dialTicksMajor: dialTicks.major,
  zeroTick,
  glass: ring(DIAL.x, DIAL.y, DIAL_R - 0.8, DIAL_TOP, P, 40),
  hub: cylinder(DIAL.x, DIAL.y, 1.35, DIAL_TOP, 0.7, P, 16),
  crown: cylinder(DIAL.x + 11, DIAL.y - 8, 2.2, 23.2, 3.4, P, 18, 0.25),
  crownKnurl: knurl(DIAL.x + 11, DIAL.y - 8, 2.2, 23.4, 26.3, 12, P, 0.25),
};

export interface Frame {
  carriage: string;
  coils: [string, string, string, string];
  needle: string;
}

function spring(y: number, from: number, to: number) {
  return coil(from, to, [y, COIL_Z], COIL_R, COIL_TURNS, 'x', P, 12);
}

export function frameOf(x: number): Frame {
  const at = Math.min(END, Math.max(HOME, x));
  const from = at + CARRIAGE.w / 2 + 1.2;
  const to = STOP_R.x - 0.4;
  const back = spring(RAIL_BACK_Y + RAIL_D / 2, from, to);
  const front = spring(RAIL_FRONT_Y + RAIL_D / 2, from, to);
  const share = (at - HOME) / SPAN;
  const angle = NEEDLE_FROM + share * (NEEDLE_TO - NEEDLE_FROM);
  return {
    carriage: translateAlong(P, [at, 0, 0]),
    coils: [back.back, front.back, back.front, front.front],
    needle: lineOnTop(
      [DIAL.x, DIAL.y],
      [DIAL.x + Math.cos(angle) * NEEDLE_R, DIAL.y + Math.sin(angle) * NEEDLE_R],
      DIAL_TOP + 0.75,
      P
    ),
  };
}

export const REST_FRAME = frameOf(HOME);

export type ScrewArt = { ring: string; dots: Flat[] };
