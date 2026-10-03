// The pure side of the visitors' map: land dots from the generated grid, and visits placed by time zone. Tested.
import { TZ_COORDS } from "./tzCoords.js";
import { DOT_ROWS, DOT_STEP, DOT_TOP } from "./worldDots.js";

/** Equirectangular: longitude -180..180 and latitude TOP..BOTTOM onto a width x height box. */
export const project = (lat: number, lon: number, w: number, h: number, top = DOT_TOP, bottom = DOT_TOP - DOT_ROWS.length * DOT_STEP) => [((lon + 180) / 360) * w, ((top - lat) / (top - bottom)) * h] as const;

/** Every land cell's centre as [lat, lon]. */
export function landDots(): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  DOT_ROWS.forEach((row, r) => {
    const lat = DOT_TOP - r * DOT_STEP;
    let col = 0;
    row.split(".").forEach((run, k) => {
      const n = Number(run);
      if (k % 2 === 1) for (let i = 0; i < n; i++) out.push([lat, -180 + DOT_STEP / 2 + (col + i) * DOT_STEP]);
      col += n;
    });
  });
  return out;
}

export interface Place {
  tz: string;
  /** The zone's city, from its name ("America/Sao_Paulo" -> "Sao Paulo"). */
  city: string;
  lat: number;
  lon: number;
  n: number;
}

/** Visits by zone onto the map; zones it cannot place (unknown names, "Etc/UTC") are counted apart. */
export function placesOf(rows: Array<[string, number]>): { places: Place[]; unplaced: number } {
  const places: Place[] = [];
  let unplaced = 0;
  for (const [tz, n] of rows) {
    const c = TZ_COORDS[tz];
    if (!c) {
      unplaced += n;
      continue;
    }
    places.push({ tz, city: (tz.split("/").pop() ?? tz).replace(/_/g, " "), lat: c[0], lon: c[1], n });
  }
  return { places, unplaced };
}

/** A dot's radius by its share of the busiest place: from 2.5 to 9 px, by the square root so a crowd does not drown the rest. */
export const radius = (n: number, max: number) => 2.5 + 6.5 * Math.sqrt(n / Math.max(1, max));
