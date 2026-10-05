import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { acquireCookieSnapshot } from "./chrome-cookies.ts";

test("the cookie database copy is shared until the source changes", () => {
	const dir = mkdtempSync(join(tmpdir(), "cookie-snapshot-test-"));
	try {
		const db = join(dir, "Cookies");
		writeFileSync(db, "v1");
		utimesSync(db, 1_700_000_000, 1_700_000_000);

		const first = acquireCookieSnapshot(db);
		const second = acquireCookieSnapshot(db);
		assert.equal(second.dbPath, first.dbPath, "an unchanged source reuses the copy");

		writeFileSync(db, "v2-longer");
		const third = acquireCookieSnapshot(db);
		assert.notEqual(third.dbPath, first.dbPath, "a changed source is copied again");

		// The old copy survives until its last reader is done.
		first.release();
		assert.equal(existsSync(first.dbPath), true);
		second.release();
		assert.equal(existsSync(first.dbPath), false);
		assert.equal(existsSync(third.dbPath), true);
		third.release();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
