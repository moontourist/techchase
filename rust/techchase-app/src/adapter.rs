use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::thread;
use std::time::{Duration, Instant};

use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, Manager};
use techchase_core::adapter::REPORT_LEN;
use techchase_usb::adapter::{Adapter, DEFAULT_QUEUE};
use techchase_usb::hotplug::open_retrying;

const READ_POLL: Duration = Duration::from_millis(100);
const BATCH: Duration = Duration::from_millis(8);

#[derive(Debug, Default)]
pub(crate) struct AdapterStream(Mutex<Option<Arc<AtomicBool>>>);

impl AdapterStream {
    fn replace(&self, next: Option<Arc<AtomicBool>>) {
        let mut slot = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(old) = slot.take() {
            old.store(true, Ordering::Relaxed);
        }
        *slot = next;
    }
}

fn pump(app: &AppHandle, mut adapter: Adapter, stop: &AtomicBool, on_reports: &Channel<Vec<u8>>) {
    let mut batch = Vec::with_capacity(REPORT_LEN * 16);
    let mut since = Instant::now();
    while !stop.load(Ordering::Relaxed) {
        match adapter.read_raw(READ_POLL) {
            Ok(Some(report)) if report.len() == REPORT_LEN => batch.extend_from_slice(&report),
            Ok(_) => {}
            Err(e) => {
                app.emit("adapter-lost", e.to_string()).ok();
                return;
            }
        }
        if !batch.is_empty() && since.elapsed() >= BATCH {
            if on_reports.send(std::mem::take(&mut batch)).is_err() {
                return;
            }
            since = Instant::now();
        }
    }
}

#[tauri::command]
pub(crate) async fn adapter_open(
    app: AppHandle,
    on_reports: Channel<Vec<u8>>,
) -> Result<String, String> {
    app.state::<AdapterStream>().replace(None);
    let adapter =
        tauri::async_runtime::spawn_blocking(|| open_retrying(|| Adapter::open(DEFAULT_QUEUE)))
            .await
            .map_err(|e| e.to_string())?
            .map_err(|e| e.to_string())?;
    let name = adapter.product.clone();
    let stop = Arc::new(AtomicBool::new(false));
    app.state::<AdapterStream>().replace(Some(Arc::clone(&stop)));
    let handle = app.clone();
    thread::spawn(move || pump(&handle, adapter, &stop, &on_reports));
    Ok(name)
}

#[tauri::command]
#[expect(
    clippy::needless_pass_by_value,
    reason = "Tauri hands commands their arguments by value"
)]
pub(crate) fn adapter_close(app: AppHandle) { app.state::<AdapterStream>().replace(None); }
