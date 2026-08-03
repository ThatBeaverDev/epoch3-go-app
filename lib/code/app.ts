import { Environment } from "@/types/worker";
import wasmBase64 from "../app.wasm";
import GoHoist from "./hoist";

export default async function* GoApp(env: Environment, args: string[]) {
	const dataURL = `data:application/wasm;base64,${wasmBase64}`;

	yield* GoHoist(dataURL, env, args);
}
