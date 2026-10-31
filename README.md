# Converge SDK for TypeScript

`@convergehq/sdk` calls the Converge platform's REST API from TypeScript and JavaScript. It has no dependencies. It runs on Node.js 20.16 or newer, and in browsers and other runtimes that have `fetch`.

It has three parts:

- **core** holds configuration, authentication, the HTTP transport and errors.
- **datasets** covers datasets (catalog, branches, schema, transactions, files, rows) and SQL.
- **ontologies** covers objects, links, actions, queries, aggregations and attachments. They are untyped, by API name.

## Install

```sh
npm install @convergehq/sdk
```

If your platform serves its own packages, route only the `@convergehq` scope to it in `.npmrc`, and never set `registry=` to it for everything:

```ini
@convergehq:registry=https://converge.example.com/api/v2/osdk/npm/
//converge.example.com/api/v2/osdk/npm/:_authToken=${CONVERGE_TOKEN}
```

## Authentication and configuration

The client needs your platform's API base URL (for example `https://converge.example.com/api`) and a token. It looks for them in this order:

1. The options: `new ConvergeClient({ hostname: "https://converge.example.com/api", token })`.
2. The environment: `CONVERGE_HOSTNAME` and `CONVERGE_TOKEN`. `FOUNDRY_TOKEN` is accepted as a fallback for the token.
3. The `[default]` section of `~/.converge/config` (Node.js only):

   ```ini
   [default]
   hostname = https://converge.example.com/api
   token = <your token>
   ```

   Make that file readable by you only (`chmod 600 ~/.converge/config`).

The token is sent only as a bearer header to the host you configured. It never appears in `toString()`, `JSON.stringify`, `util.inspect` or an error message. The client refuses HTTP redirects, so the token can never follow one to another host. It also refuses a plain-http base URL, except for `localhost`, `127.0.0.1` and `[::1]`.

```ts
import { ConvergeClient } from "@convergehq/sdk";

const client = new ConvergeClient();   // from the environment or ~/.converge/config
```

Pass `auth: () => getFreshToken()` instead of `token` to fetch a token per request.

## Datasets

```ts
const ds = await client.datasets.create("orders", { parentFolderRid: "ri.example.folder.1" });

await client.datasets.withTransaction(ds.rid, "master", "APPEND", async (tx) => {   // commits, or aborts on error
  await tx.writeRows([{ id: 1, total: 12.5 }]);
  await tx.uploadFile("more.csv", csvBytes, "text/csv");
});

for await (const row of client.datasets.iterateRows(ds.rid)) console.log(row);

const rows = await client.sql.execute("SELECT count(*) AS n FROM `/Project/orders`");   // array of objects
```

The client also covers `get`, `iterate`, `delete`, `createBranch`, `listBranches`, `deleteBranch`, `getSchema`, `putSchema`, `listFiles`, `readFile` and `readTable` (one page, with an optional single-column filter).

## Ontologies, without generated code

```ts
const o = client.ontology("my-ontology");

const big = await o.objects("Order")
  .where({ total: { $gt: 100 }, $not: { status: "closed" } })
  .orderBy({ total: "desc" })
  .take(10);
const customer = await o.objects("Order").linked("o1", "placedBy").fetchOne("c1");
await o.action("place_order")({ order_id: "o9" }, { mode: "VALIDATE_ONLY" });
const value = await o.query("customer_lifetime_value")({ customer_rid: "customer/c1" });
const att = await o.attachments.upload(pdfBytes, "invoice.pdf", "application/pdf");
```

Filters use the object form:
- `{ property: value }` means equality, and `{ property: null }` means no value.
- The operators are `$eq`, `$ne`, `$gt`, `$gte`, `$lt`, `$lte`, `$in`, `$range`, `$startsWith`, `$regex` and `$isNull` (`true` or `false`). `$ne` also matches objects with no value.
- `whereClause({ type, ... })` adds a clause already in the server's wire form.
- Combine filters with `$and`, `$or` and `$not`.

On one object type, `$or` is a union, `$and` an intersection, and `{ $and: [a, { $not: b }] }` subtracts `b` from `a`. Pages hold 1 to 1000 objects; use `fetchPage`, `asyncIter` or `take`.

## Generated ontology packages

Your platform also generates a typed TypeScript package per ontology (`@convergehq/osdk-<ontology>`), with types for your object types, actions and queries. That package is self-contained today; it does not depend on this one.

## Not available yet

These are not available yet: dataset views, projections, retention policies, Iceberg tables, set operations across object types, media properties, and the SQL job list. The SDK only calls routes the server has today.

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE). Copyright 2026 PT ANTERO DAEMON TEKNOLOGI.

## Security

Report vulnerabilities privately. See [SECURITY.md](SECURITY.md).
