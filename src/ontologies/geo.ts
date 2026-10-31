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

function parse(v: unknown, point: boolean): GeoJsonGeometry | undefined {
  let g: unknown = v;
  if (typeof g === "string" && g.trim().startsWith("{")) {
    try { g = JSON.parse(g); } catch { return undefined; }
  } else if (typeof g === "string" && point) {
    // the server's text form is "lat,lon"
    const ll = g.split(",").map((x) => (x.trim() ? Number(x) : NaN));
    return ll.length === 2 && ll.every(Number.isFinite) ? { type: "Point", coordinates: [ll[1], ll[0]] } : undefined;
  }
  if (g && typeof g === "object" && (g as { type?: unknown }).type === "Feature") g = (g as { geometry?: unknown }).geometry;
  return g && typeof g === "object" && typeof (g as { type?: unknown }).type === "string" ? g as GeoJsonGeometry : undefined;
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
