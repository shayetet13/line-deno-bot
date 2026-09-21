import { assertEquals } from "@std/assert";
import { BaseClient } from "../core/mod.ts";

for (const v3 of [false, true]) {
	for (const kind of ["qr", "password"]) {
		Deno.test(`${kind} v${v3 ? 3 : 2} verifies E2EE after installing auth token`, async () => {
			const client = new BaseClient({ device: "DESKTOPWIN" });
			const login = client.loginProcess;
			login.requestSQR = login.requestSQR2 = () =>
				Promise.resolve("test-token");
			login.requestEmailLogin = login.requestEmailLoginV2 = () =>
				Promise.resolve("test-token");
			let verified = false;
			client.e2ee.verifyLoginKey = () => {
				assertEquals(client.authToken, "test-token");
				verified = true;
				return Promise.resolve();
			};
			if (kind === "qr") await login.withQrCode({ v3 });
			else {await login.withPassword({
					v3,
					email: "test@example.com",
					password: "testPassword123",
				});}
			assertEquals(verified, true);
		});
	}
}
