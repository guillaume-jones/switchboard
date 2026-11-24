TRIPLE := $(shell rustc -vV | sed -n 's/^host: //p')
OS := $(shell uname -s)

# To keep macOS permissions across rebuilds, create a self-signed code signing certificate with this name.
LOCAL_IDENTITY := Switchboard Local
ifneq ($(shell security find-identity -p codesigning 2>/dev/null | grep '"$(LOCAL_IDENTITY)"'),)
APPLE_SIGNING_IDENTITY ?= $(LOCAL_IDENTITY)
export APPLE_SIGNING_IDENTITY
endif

.PHONY: dev build install test bench check fmt sidecar

dev: sidecar | app/node_modules
	cd app && npx tauri dev

build: sidecar | app/node_modules
	cd app && npx tauri build $(if $(filter Linux,$(OS)),--no-bundle)

install: build
ifeq ($(OS),Darwin)
	rm -rf /Applications/Switchboard.app
	cp -R target/release/bundle/macos/Switchboard.app /Applications/
else
	install -Dm 755 -t $(HOME)/.local/bin target/release/switchboard target/release/swb target/release/swb-hold
	install -Dm 644 app/src-tauri/icons/128x128.png $(HOME)/.local/share/icons/hicolor/128x128/apps/switchboard.png
	mkdir -p $(HOME)/.local/share/applications
	printf '[Desktop Entry]\nType=Application\nName=Switchboard\nExec=$(HOME)/.local/bin/switchboard\nIcon=switchboard\nCategories=Utility;\n' \
		> $(HOME)/.local/share/applications/switchboard.desktop
endif

test: | app/node_modules
	cargo test
	cd app && npm test && npm run build

bench: sidecar | app/node_modules
	cargo run --release --example bench -p switchboard-core

fmt: | app/node_modules
	cd app && npm run fmt

check: sidecar | app/node_modules
	cargo clippy --workspace --all-targets -- -D warnings
	cargo test --release -p switchboard-cli --test cli swb_loads_no_frameworks
	cd app && npx tsc -p . && npx tsc -p tsconfig.cards.json
	app/node_modules/.bin/oxfmt --check app template/cards

sidecar:
	cargo build --release -p switchboard-cli -p switchboard-core --bin swb --bin swb-hold
	mkdir -p app/src-tauri/binaries
	cp target/release/swb app/src-tauri/binaries/swb-$(TRIPLE)
	cp target/release/swb-hold app/src-tauri/binaries/swb-hold-$(TRIPLE)

app/node_modules:
	cd app && npm ci
