mkdir -p build dist

npx tsc -b

GOOS=js GOARCH=wasm go build -o build/app.wasm

npx rollup -c