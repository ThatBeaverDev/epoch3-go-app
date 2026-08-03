import { Environment } from "@/types/worker";
import "./wasm_exec.js";

export default async function* GoHoist(
	wasmBuffer: Uint8Array,
	env: Environment,
	args: string[]
) {
	// Map virtual file descriptors to paths/buffers
	const openFiles = new Map<number, { path: string; offset: number }>();
	let nextFd = 3; // FDs 0, 1, 2 are stdin, stdout, stderr

	const textEncoder = new TextEncoder();
	const textDecoder = new TextDecoder();

	// stderr/stdout (for output once done)
	let stdoutBuffer = "";
	let stderrBuffer = "";

	function getErrorCode(err: any): string {
		const msg = String(err).toLowerCase();
		if (msg.includes("access denied") || msg.includes("permission")) {
			return "EACCES"; // access denied
		}
		if (msg.includes("not found") || msg.includes("no such")) {
			return "ENOENT"; // file not found
		}
		return "EIO"; // general error
	}

	function formatJsError(message: string, code = "ENOENT"): Error {
		const err = new Error(message);

		(err as any).code = code;

		return err;
	}

	function handleStandardOutput(fd: number, buf: Uint8Array): number {
		const str = textDecoder.decode(buf);

		if (fd === 1) {
			// FD 1 = STDOUT (fmt.Print, print, etc.)
			stdoutBuffer += str;
			const lines = stdoutBuffer.split("\n");
			stdoutBuffer = lines.pop() || "";
			for (const line of lines) {
				env.print(line);
			}
		} else if (fd === 2) {
			// FD 2 = STDERR (panic, log.Print, os.Stderr)
			stderrBuffer += str;
			const lines = stderrBuffer.split("\n");
			stderrBuffer = lines.pop() || "";
			for (const line of lines) {
				env.error(line);
			}
		}

		return buf.length;
	}

	// Helper to generate a Node-like Stats object expected by Go's syscall.setStat()
	function createMockStat(size = 1024, isDir = false) {
		const now = Date.now();
		return {
			dev: 0,
			ino: 0,
			mode: isDir ? 0o040755 : 0o100644,
			nlink: 1,
			uid: 0,
			gid: 0,
			rdev: 0,
			size: size,
			blksize: 4096,
			blocks: Math.ceil(size / 512),
			atimeMs: now,
			mtimeMs: now,
			ctimeMs: now,
			isDirectory: () => isDir
		};
	}

	// @ts-expect-error
	globalThis.fs = {
		constants: {
			O_RDONLY: 0,
			O_WRONLY: 1,
			O_RDWR: 2,
			O_CREAT: 64,
			O_EXCL: 128,
			O_TRUNC: 512,
			O_APPEND: 1024,
			O_DIRECTORY: 65536
		},

		// os.Open / os.OpenFile
		open(
			path: string,
			_: number,
			_2: number,
			callback: (err: Error | null, fd?: number) => void
		) {
			const fd = nextFd++;
			openFiles.set(fd, { path, offset: 0 });
			callback(null, fd);
		},

		// os.ReadFile / file.Read
		read(
			fd: number,
			buffer: Uint8Array,
			offset: number,
			length: number,
			position: number | null,
			callback: (err: Error | null, n?: number) => void
		) {
			const file = openFiles.get(fd);
			if (!file) {
				callback(formatJsError("bad file descriptor", "EBADF"), 0);
				return;
			}

			env.fs
				.readFile(file.path, "text")
				// @ts-expect-error
				.then((string: string | undefined) => {
					if (string === undefined) {
						callback(
							formatJsError(
								`no such file or directory '${file.path}'`,
								"ENOENT"
							),
							0
						);
						return;
					}

					const data = textEncoder.encode(string);
					const pos = position !== null ? position : file.offset;
					const bytesToCopy = Math.min(length, data.length - pos);

					if (bytesToCopy <= 0) {
						callback(null, 0);
						return;
					}

					buffer.set(data.subarray(pos, pos + bytesToCopy), offset);
					file.offset = pos + bytesToCopy;

					callback(null, bytesToCopy);
				})
				.catch((err) => {
					const message = err?.message || String(err);
					const code = getErrorCode(err);
					callback(formatJsError(message, code), 0);
				});
		},

		// os.Write / os.Create / WriteFile
		write(
			fd: number,
			buf: Uint8Array,
			offset: number,
			length: number,
			_: number | null,
			callback: (err: Error | null, n?: number) => void
		) {
			const chunk = buf.subarray(offset, offset + length);

			// if stdout/stderr, don't try writing
			if (fd === 1 || fd === 2) {
				const written = handleStandardOutput(fd, chunk);
				callback(null, written);
				return;
			}

			// write to constellation fs
			const file = openFiles.get(fd);
			if (!file) {
				callback(formatJsError("bad file descriptor", "EBADF"), 0);
				return;
			}

			const strContent = textDecoder.decode(chunk);
			env.fs
				.writeFile(file.path, strContent)
				.then(() => callback(null, length))
				.catch((err) => callback(formatJsError(String(err), "EIO"), 0));
		},

		// handle panic
		writeSync(fd: number, buf: Uint8Array): number {
			if (fd === 1 || fd === 2) {
				return handleStandardOutput(fd, buf);
			}
			return buf.length;
		},

		// os.Stat / os.Lstat
		stat(path: string, callback: (err: Error | null, stats?: any) => void) {
			env.fs
				.stats(path)
				.then((stats) => {
					if (!stats) {
						callback(
							formatJsError(
								`no such file or directory '${path}'`,
								"ENOENT"
							)
						);
						return;
					}
					callback(
						null,
						createMockStat(stats.size, stats.type === "directory")
					);
				})
				.catch((err) => {
					const message = err?.message || String(err);
					const code = getErrorCode(err);
					callback(formatJsError(message, code));
				});
		},

		lstat(
			path: string,
			callback: (err: Error | null, stats?: any) => void
		) {
			// @ts-expect-error
			globalThis.fs.stat(path, callback);
		},

		fstat(fd: number, callback: (err: Error | null, stats?: any) => void) {
			const file = openFiles.get(fd);
			if (!file) {
				callback(null, createMockStat(1024, false));
				return;
			}

			env.fs
				.stats(file.path)
				.then((stats) => {
					if (!stats) {
						callback(null, createMockStat(1024, false));
						return;
					}
					callback(
						null,
						createMockStat(stats.size, stats.type === "directory")
					);
				})
				.catch(() => {
					callback(null, createMockStat(1024, false));
				});
		},

		readdir(
			path: string,
			callback: (err: Error | null, files?: string[]) => void
		) {
			env.fs
				.readdir(path)
				.then((items) => callback(null, items))
				.catch((err) => {
					const message = err?.message || String(err);
					const code = getErrorCode(err);
					callback(formatJsError(message, code));
				});
		},

		mkdir(path: string, _: number, callback: (err: Error | null) => void) {
			env.fs
				.mkdir(path)
				.then(() => callback(null))
				.catch((err) => callback(formatJsError(String(err), "EIO")));
		},

		unlink(path: string, callback: (err: Error | null) => void) {
			env.fs
				.unlink(path)
				.then(() => callback(null))
				.catch((err) => callback(formatJsError(String(err), "EIO")));
		},

		close(fd: number, callback: (err: Error | null) => void) {
			openFiles.delete(fd);
			callback(null);
		}
	};

	// @ts-expect-error
	globalThis.process = globalThis.process || {};

	// @ts-expect-error
	globalThis.process.cwd = function () {
		return env.workingDirectory;
	};

	// @ts-expect-error
	globalThis.process.chdir = function (dir) {
		// Add your path validation / resolution logic here
		env.workingDirectory = dir;
	};

	// @ts-expect-error
	const go = new Go();
	go.argv = ["app.go", ...args];

	// run it
	const result = await WebAssembly.instantiate(wasmBuffer, go.importObject);
	// @ts-expect-error
	await go.run(result.instance);

	// put extra logs to output before exiting
	if (stdoutBuffer) env.print(stdoutBuffer);
	if (stderrBuffer) env.error(stderrBuffer);
}
