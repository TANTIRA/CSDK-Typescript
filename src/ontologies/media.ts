/**
 * Media reference properties: an object's property that names a media item. The server checks
 * both the object (visibility, markings, masking) and the media set before it answers.
 */
import { parse, quote } from "../core/transport.js";
import type { Ontology } from "./objects.js";

/** What a media reference property holds. */
export interface MediaReference {
  mimeType: string;
  reference: { type: string; [k: string]: unknown };
}

export interface MediaMetadata {
  path?: string;
  sizeBytes: number;
  mediaType: string;
}

/** A MediaReference from a property value (an object, or JSON text), or undefined. */
export function mediaReference(value: unknown): MediaReference | undefined {
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as MediaReference) : undefined;
}

/** What the object routes take: the $rid ("order/o1"), from a key or a $rid. */
function objectRid(objectType: string, primaryKey: string | number): string {
  const k = String(primaryKey);
  return k.includes("/") ? k : objectType.toLowerCase() + "/" + k;
}

/** One media reference property of one object. */
export class Media {
  readonly #o: Ontology;
  readonly #path: string;
  /** The MediaReference the property holds, when it was read with the object. */
  readonly reference: MediaReference | undefined;

  constructor(o: Ontology, objectType: string, objectRidOrKey: string | number, property: string, reference?: MediaReference) {
    this.#o = o;
    this.#path = `/objects/${quote(objectType)}/${quote(objectRid(objectType, objectRidOrKey))}/media/${quote(property)}`;
    this.reference = reference;
  }

  /** The bytes. Treat them as untrusted: never render them inline in a page of the API's origin. */
  fetchContents(): Promise<Uint8Array> {
    const t = this.#o.transport;
    return t.send("GET", t.base + this.#o.base + this.#path + "/content");
  }

  fetchMetadata(): Promise<MediaMetadata> {
    return this.#o.request("GET", this.#path + "/metadata");
  }
}

/** `ontology.media`: read a media property by object, or upload into one. */
export class MediaClient {
  readonly #o: Ontology;

  constructor(o: Ontology) {
    this.#o = o;
  }

  /** The media of one object's property ("o1" or "order/o1"); the reference is read with it. */
  async get(objectType: string, primaryKey: string | number, property: string): Promise<Media> {
    const rid = objectRid(objectType, primaryKey);
    const obj = (await this.#o.request("GET", `/objects/${quote(objectType)}/${quote(rid)}`)) ?? {};
    return new Media(this.#o, objectType, rid, property, mediaReference(obj[property]));
  }

  /** Upload bytes into the media set of a media property -> the MediaReference to pass to an action
   * that writes the property. */
  async upload(objectType: string, property: string, data: Uint8Array | ArrayBuffer | Blob,
    options: { mediaItemPath?: string } = {}): Promise<MediaReference> {
    if (!(data instanceof Uint8Array || data instanceof ArrayBuffer || data instanceof Blob)) {
      throw new TypeError("upload: data must be a Uint8Array, an ArrayBuffer or a Blob");
    }
    const t = this.#o.transport;
    let url = `${t.base}${this.#o.base}/objectTypes/${quote(objectType)}/media/${quote(property)}/upload`;
    if (options.mediaItemPath !== undefined) url += "?" + new URLSearchParams({ mediaItemPath: options.mediaItemPath });
    return parse(await t.send("POST", url, data as BodyInit, { "Content-Type": "application/octet-stream" })) as MediaReference;
  }
}
