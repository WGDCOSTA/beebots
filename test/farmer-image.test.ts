import { mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Db } from "../src/db.js";
import { EventBus } from "../src/events.js";
import { startServer } from "../src/server.js";
import { Visitors } from "../src/visitors.js";

let close: (() => void) | null = null;
afterEach(() => close?.());

describe("the Farmer's portrait", () => {
  it("is served once painted, and says so while it is not", async () => {
    const db = new Db(":memory:");
    let file: string | null = null;
    const server = startServer({ engine: { bus: new EventBus(db), db, visitors: new Visitors(db), snapshot: () => ({}), health: () => ({ ok: true }), farmerImage: () => file }, profile: () => ({}), beeImage: () => null }, 0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    close = () => server.close();
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/farmer-image`;
    expect((await fetch(url)).status).toBe(404);
    file = join(mkdtempSync(join(tmpdir(), "farmer-")), "farmer.jpg");
    writeFileSync(file, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    const r = await fetch(url);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("image/jpeg");
    expect((await r.arrayBuffer()).byteLength).toBe(4);
  });
});
