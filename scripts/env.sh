# Source this before running cargo in the sandboxed dev VM:  . scripts/env.sh
# (System rustup lives on a read-only FS; we use a user-space toolchain with wasm32.)
export RUSTUP_HOME="$HOME/.rustup"
export CARGO_HOME="$HOME/.cargo"
export PATH="$HOME/.cargo/bin:$PATH"
