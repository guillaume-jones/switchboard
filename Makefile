TRIPLE := $(shell rustc -vV | sed -n 's/^host: //p')

.PHONY: dev build install test bench check fmt sidecar

dev: sidecar | app/node_modules
	cd app && npx tauri dev

build: sidecar | app/node_modules
	cd app && npx tauri build

install: build
	rm -rf /Applications/Switchboard.app
	cp -R target/release/bundle/macos/Switchboard.app /Applications/

test: | app/node_modules
	cargo test
	cd app && npm test && npm run build

bench: sidecar | app/node_modules
	cargo run --release --example bench -p switchboard-core
	cd app && npm run bench

fmt: | app/node_modules
	cd app && npm run fmt

check: sidecar | app/node_modules
	cargo clippy --workspace --all-targets -- -D warnings
	cargo test --release -p switchboard-cli --test cli swb_loads_no_frameworks
	cd app && npx tsc -p . && npx tsc -p tsconfig.cards.json
	app/node_modules/.bin/oxfmt --check app template/cards

sidecar:
	cargo build --release -p switchboard-cli
	mkdir -p app/src-tauri/binaries
	cp target/release/swb app/src-tauri/binaries/swb-$(TRIPLE)

app/node_modules:
	cd app && npm ci
