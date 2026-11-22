use techchase_core::dolphin::{self, Fixed, Report};

#[tauri::command]
pub(crate) async fn dolphin_check() -> Result<Report, String> {
    tauri::async_runtime::spawn_blocking(|| {
        dolphin::check(&dolphin::default_installs(), dolphin::dolphin_running())
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) async fn dolphin_fix(install: String, port: usize) -> Result<Fixed, String> {
    tauri::async_runtime::spawn_blocking(move || {
        dolphin::write_profile(
            &dolphin::default_installs(),
            &install,
            port,
            dolphin::dolphin_running(),
            &dolphin::stamp_now(),
        )
        .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}
