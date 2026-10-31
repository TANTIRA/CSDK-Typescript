/**
 * GeoJSON (RFC 7946) for geopoint and geoshape properties. The SDK is untyped, so it does not know
 * which properties are geo: read one through geoPoint() / geoShape(). In `where`, pass the stored
 * text ("lat,lon" or GeoJSON) as for any other property.
 */

/** [longitude, latitude], optionally an altitude. */
export type Position = [number, number] | [number, number, number];
export interface GeoJsonPoint { type: "Point"; coordinates: Position }
export type GeoJsonGeometry =
  | GeoJsonPoint
  | { type: "MultiPoint" | "LineString"; coordinates: Position[] }
  | { type: "MultiLineString" | "Polygon"; coordinates: Position[][] }
  | { type: "MultiPolygon"; coordinates: Position[][][] }
  | { type: "GeometryCollection"; geometries: GeoJsonGeometry[] };

/** [lon, lat] or [lon, lat, alt]: finite numbers, longitude within ±180, latitude within ±90. */
const isPosition = (p: unknown): boolean => Array.isArray(p) && (p.length === 2 || p.length === 3)
  && p.every((n) => typeof n === "number" && Number.isFinite(n)) && Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 90;
const NESTING: Record<string, number> = { Point: 0, MultiPoint: 1, LineString: 1, MultiLineString: 2, Polygon: 2, MultiPolygon: 3 };
const isCoords = (c: unknown, depth: number): boolean =>
  depth === 0 ? isPosition(c) : Array.isArray(c) && c.every((x) => isCoords(x, depth - 1));

/** level 0: a Point only (a geopoint); 1 and up: any geometry, collections nested at most 4 deep. */
function isGeometry(g: unknown, level: number): boolean {
  if (!g || typeof g !== "object") return false;
  const { type, coordinates, geometries } = g as { type?: unknown; coordinates?: unknown; geometries?: unknown };
  if (level === 0) return type === "Point" && isPosition(coordinates);
  if (type === "GeometryCollection") return level <= 4 && Array.isArray(geometries) && geometries.every((x) => isGeometry(x, level + 1));
  return typeof type === "string" && Object.hasOwn(NESTING, type) && isCoords(coordinates, NESTING[type]);
}

function parse(v: unknown, point: boolean): GeoJsonGeometry | undefined {
  let g: unknown = v;
  if (typeof g === "string" && g.trim().startsWith("{")) {
    try { g = JSON.parse(g); } catch { return undefined; }
  } else if (typeof g === "string" && point) {
    // the server's text form is decimal "lat,lon"; Number() would also read hex, exponents and blanks
    const m = g.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
    const p = m && [Number(m[2]), Number(m[1])];
    return p && isPosition(p) ? { type: "Point", coordinates: p as [number, number] } : undefined;
  }
  if (g && typeof g === "object" && (g as { type?: unknown }).type === "Feature") g = (g as { geometry?: unknown }).geometry;
  return isGeometry(g, point ? 0 : 1) ? g as GeoJsonGeometry : undefined;
}

/** A stored geopoint ("lat,lon", a GeoJSON Point or its JSON text) as a GeoJSON Point; undefined otherwise. */
export function geoPoint(value: unknown): GeoJsonPoint | undefined {
  const g = parse(value, true);
  return g?.type === "Point" ? g : undefined;
}

/** A stored geoshape (GeoJSON, a Feature, or its JSON text) as a GeoJSON geometry; undefined otherwise. */
export function geoShape(value: unknown): GeoJsonGeometry | undefined {
  return parse(value, false);
}
