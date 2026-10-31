/** Attachments: outside the ontology path, at /v2/ontologies/attachments. */
import { filePart, type Bytes } from "../datasets/client.js";
import { parse, quote, type Transport } from "../core/transport.js";

// the server's media type grammar: no line break can add a header
const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/;

export class Attachments {
  readonly #t: Transport;
  readonly #url: string;

  constructor(transport: Transport) {
    this.#t = transport;
    this.#url = transport.base + "/v2/ontologies/attachments";
  }

  /** Upload bytes; pass the returned rid as an attachment parameter of an action. */
  async upload(data: Bytes, filename: string, mediaType = "application/octet-stream"): Promise<any> {
    if (!MEDIA_TYPE.test(mediaType)) throw new TypeError("upload: mediaType must look like type/subtype");
    return parse(await this.#t.send("POST", this.#url + "/upload", filePart(data, filename, mediaType)));
  }

  async get(rid: string): Promise<any> {
    return parse(await this.#t.send("GET", this.#url + "/" + quote(rid)));
  }

  /** The bytes; readable when you uploaded it or can read an object that references it. */
  read(rid: string): Promise<Uint8Array> {
    return this.#t.send("GET", this.#url + "/" + quote(rid) + "/content");
  }
}
