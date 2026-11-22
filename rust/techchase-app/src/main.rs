#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod dolphin;
mod usb;

use std::io::Write as _;
use std::process::ExitCode;

fn main() -> ExitCode {
    let result = tauri::Builder::default()
        .manage(usb::Usb::default())
        .setup(|app| {
            usb::start(app.handle())?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            usb::usb_devices,
            usb::usb_open,
            usb::usb_send,
            usb::usb_close,
            dolphin::dolphin_check,
            dolphin::dolphin_fix
        ])
        .run(tauri::generate_context!());
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            writeln!(std::io::stderr(), "{e}").ok();
            ExitCode::FAILURE
        }
    }
}
