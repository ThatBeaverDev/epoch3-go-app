import { Environment } from "@/types/worker";
import wasmBase64 from "../app.wasm";
import GoHoist from "./hoist";

const b64Alphabet =
	"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const b64Lookup = new Uint8Array(256);
for (let i = 0; i < b64Alphabet.length; i++) {
	b64Lookup[b64Alphabet.charCodeAt(i)] = i;
}

function dataUrlToUint8Array(dataUrl: string): Uint8Array {
	// Strip header (e.g. "data:application/wasm;base64,")
	const base64Str = dataUrl.substring(dataUrl.indexOf(",") + 1);
	const len = base64Str.length;

	let padding = 0;
	if (base64Str.endsWith("==")) padding = 2;
	else if (base64Str.endsWith("=")) padding = 1;

	const bytes = new Uint8Array((len * 3) / 4 - padding);
	let p = 0;

	for (let i = 0; i < len; i += 4) {
		const a = b64Lookup[base64Str.charCodeAt(i)];
		const b = b64Lookup[base64Str.charCodeAt(i + 1)];
		const c = b64Lookup[base64Str.charCodeAt(i + 2)];
		const d = b64Lookup[base64Str.charCodeAt(i + 3)];

		bytes[p++] = (a << 2) | (b >> 4);
		if (p < bytes.length) bytes[p++] = ((b & 15) << 4) | (c >> 2);
		if (p < bytes.length) bytes[p++] = ((c & 3) << 6) | (d & 63);
	}

	return bytes;
}

export default async function* GoApp(env: Environment, args: string[]) {
	const dataURL = `data:application/wasm;base64,${wasmBase64}`;

	yield* GoHoist(dataUrlToUint8Array(dataURL), env, args);
}
