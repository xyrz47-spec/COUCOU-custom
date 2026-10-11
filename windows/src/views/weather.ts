// The weather's icons, drawn on a 24×24 grid in the colours of what they
// show: a yellow sun, a pale moon, grey cloud, blue rain, white snow.

import type { WeatherKind } from "../core/weather";

const NS = "http://www.w3.org/2000/svg";

const SUN = "#FFC83D";
const MOON = "#FFE9A6";
const CLOUD = "#D9DEE7";
const RAIN = "#5DB1FF";
const SNOW = "#FFFFFF";
const BOLT = "#FFD23F";
const FOG = "#B8BEC9";

/** One shape of an icon: filled, or a stroke of `width`. */
interface Shape {
  d: string;
  color: string;
  width?: number;
  transform?: string;
}

const CLOUD_PATH = "M6.5 19a4.5 4.5 0 0 1-.6-8.96 6 6 0 0 1 11.6-1.5A5.25 5.25 0 0 1 17.5 19h-11z";
const MOON_PATH = "M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z";

/** A filled circle, as a path. */
function disc(cx: number, cy: number, r: number): string {
  return `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0z`;
}

/** Eight rays around (cx, cy), from `from` to `to` px out. */
function rays(cx: number, cy: number, from: number, to: number): string {
  let d = "";
  for (let i = 0; i < 8; i++) {
    const a = (i * Math.PI) / 4;
    const x = Math.cos(a);
    const y = Math.sin(a);
    const at = (r: number, v: number, c: number) => (c + r * v).toFixed(2);
    d += `M${at(from, x, cx)} ${at(from, y, cy)}L${at(to, x, cx)} ${at(to, y, cy)}`;
  }
  return d;
}

/** A cloud with room under it for what falls from it. */
const HIGH_CLOUD: Shape = { d: CLOUD_PATH, color: CLOUD, transform: "translate(1.6 -3.2) scale(0.86)" };
/** A cloud in front of a sun or a moon. */
const LOW_CLOUD: Shape = { d: CLOUD_PATH, color: CLOUD, transform: "translate(5 6.4) scale(0.76)" };

const SHAPES: Record<WeatherKind, Shape[]> = {
  "clear-day": [
    { d: disc(12, 12, 4.6), color: SUN },
    { d: rays(12, 12, 7.2, 9.8), color: SUN, width: 2 },
  ],
  "clear-night": [{ d: MOON_PATH, color: MOON, transform: "translate(1.8 1.8) scale(0.85)" }],
  "partly-day": [
    { d: disc(8.6, 8.6, 3.5), color: SUN },
    { d: rays(8.6, 8.6, 5.4, 7.4), color: SUN, width: 1.8 },
    LOW_CLOUD,
  ],
  "partly-night": [
    { d: MOON_PATH, color: MOON, transform: "translate(0.4 0.2) scale(0.6)" },
    LOW_CLOUD,
  ],
  cloudy: [
    { d: CLOUD_PATH, color: "#9BA3B1", transform: "translate(7.2 1) scale(0.62)" },
    { d: CLOUD_PATH, color: CLOUD, transform: "translate(0.4 3.6) scale(0.86)" },
  ],
  fog: [{ d: "M4 8.5h16M6.5 12.5h13.5M4 16.5h12.5", color: FOG, width: 2.2 }],
  drizzle: [HIGH_CLOUD, { d: "M9.6 17.6l-.7 2.1M14.6 17.6l-.7 2.1", color: RAIN, width: 2 }],
  rain: [HIGH_CLOUD, { d: "M8.2 17.2l-1.2 3.6M12.4 17.2l-1.2 3.6M16.6 17.2l-1.2 3.6", color: RAIN, width: 2 }],
  snow: [HIGH_CLOUD, { d: disc(7.8, 19, 1.25) + disc(12.2, 20.4, 1.25) + disc(16.6, 19, 1.25), color: SNOW }],
  thunder: [HIGH_CLOUD, { d: "M13.4 14.2l-3.6 4.6h2.7l-1.3 3.7 4.4-5.2h-2.8l1.5-3.1z", color: BOLT }],
};

/** The icon of a kind of sky, `size` px a side. */
export function weatherIcon(kind: WeatherKind, size: number): SVGSVGElement {
  const el = document.createElementNS(NS, "svg");
  el.setAttribute("viewBox", "0 0 24 24");
  el.setAttribute("width", String(size));
  el.setAttribute("height", String(size));
  el.setAttribute("aria-hidden", "true");
  el.setAttribute("data-kind", kind);
  for (const shape of SHAPES[kind]) {
    const path = document.createElementNS(NS, "path");
    path.setAttribute("d", shape.d);
    if (shape.width) {
      path.setAttribute("fill", "none");
      path.setAttribute("stroke", shape.color);
      path.setAttribute("stroke-width", String(shape.width));
      path.setAttribute("stroke-linecap", "round");
    } else {
      path.setAttribute("fill", shape.color);
    }
    if (shape.transform) path.setAttribute("transform", shape.transform);
    el.append(path);
  }
  return el;
}
