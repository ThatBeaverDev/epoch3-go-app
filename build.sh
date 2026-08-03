mkdir -p build dist

npx tsc -b

GOOS=js GOARCH=wasm go build -ldflags="-s -w" -o build/app.wasm

npx rollup -c