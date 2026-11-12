fn main() {
    println!("cargo:rerun-if-changed=core-source");
    println!("cargo:rerun-if-changed=../template");
}
