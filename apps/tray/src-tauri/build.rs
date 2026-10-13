fn main() {
    // 应用自己的命令要写进 ACL 清单：设置页是本机 8787 的网页（远程来源），只有 capabilities/remote-ui.json 放行的命令能调
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&[
        "app_update_status",
        "app_update_check",
        "app_update_install",
        "app_update_set_auto",
        "pet_hitbox",
        "pet_drag",
        "pet_open_main",
    ])))
    .expect("tauri build");
}
