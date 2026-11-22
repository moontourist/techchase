use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::thread;
use std::time::Duration;

use nusb::{DeviceId, DeviceInfo};
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, Manager};
use techchase_usb::UsbError;
use techchase_usb::gcu::{Gcu, GcuIn, GcuOut};
use techchase_usb::hotplug::{self, Event, Kind, open_retrying};

const READ_POLL: Duration = Duration::from_millis(100);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Desc {
    id: u32,
    vendor_id: u16,
    product_id: u16,
    product_name: String,
}

#[derive(Debug)]
struct Opened {
    out: GcuOut,
    stop: Arc<AtomicBool>,
}

impl Drop for Opened {
    fn drop(&mut self) { self.stop.store(true, Ordering::Relaxed); }
}

#[derive(Debug, Default)]
struct Inner {
    next_id: u32,
    present: HashMap<u32, (Desc, DeviceInfo)>,
    opened: HashMap<u32, Opened>,
}

impl Inner {
    fn add(&mut self, info: DeviceInfo) -> Desc {
        self.next_id = self.next_id.wrapping_add(1);
        let desc = Desc {
            id: self.next_id,
            vendor_id: info.vendor_id(),
            product_id: info.product_id(),
            product_name: info.product_string().unwrap_or("controller").to_owned(),
        };
        self.present.insert(desc.id, (desc.clone(), info));
        desc
    }

    fn remove(&mut self, usb_id: DeviceId) -> Option<u32> {
        let id = self
            .present
            .iter()
            .find(|(_, (_, info))| info.id() == usb_id)
            .map(|(id, _)| *id)?;
        self.present.remove(&id);
        self.opened.remove(&id);
        Some(id)
    }
}

#[derive(Debug, Default)]
pub(crate) struct Usb(Mutex<Inner>);

impl Usb {
    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

fn handle(app: &AppHandle, event: Event) {
    let usb = app.state::<Usb>();
    match event {
        Event::Present(Kind::Gcu, info) => {
            usb.lock().add(info);
        }
        Event::Arrived(Kind::Gcu, info) => {
            let desc = usb.lock().add(info);
            app.emit("usb-connect", desc).ok();
        }
        Event::Left(Kind::Gcu, usb_id) => {
            let gone = usb.lock().remove(usb_id);
            if let Some(id) = gone {
                app.emit("usb-disconnect", id).ok();
            }
        }
        Event::Present(Kind::Adapter | Kind::Other, _)
        | Event::Arrived(Kind::Adapter | Kind::Other, _)
        | Event::Left(Kind::Adapter | Kind::Other, _) => {}
    }
}

pub(crate) fn start(app: &AppHandle) -> Result<(), UsbError> {
    let events = hotplug::watch()?;
    while let Ok(event) = events.try_recv() {
        handle(app, event);
    }
    let app = app.clone();
    thread::spawn(move || {
        while let Ok(event) = events.recv() {
            handle(&app, event);
        }
    });
    Ok(())
}

fn pump(mut inp: GcuIn, stop: &AtomicBool, on_packet: &Channel<Vec<u8>>) {
    while !stop.load(Ordering::Relaxed) {
        match inp.next(READ_POLL) {
            Ok(Some(packet)) => {
                if on_packet.send(packet).is_err() {
                    return;
                }
            }
            Ok(None) => {}
            Err(_) => return,
        }
    }
}

#[tauri::command]
#[expect(
    clippy::needless_pass_by_value,
    reason = "Tauri hands commands their arguments by value"
)]
pub(crate) fn usb_devices(app: AppHandle) -> Vec<Desc> {
    let mut list: Vec<Desc> =
        app.state::<Usb>().lock().present.values().map(|(d, _)| d.clone()).collect();
    list.sort_unstable_by_key(|d| d.id);
    list
}

#[tauri::command]
pub(crate) async fn usb_open(
    app: AppHandle,
    id: u32,
    on_packet: Channel<Vec<u8>>,
) -> Result<(), String> {
    let usb = app.state::<Usb>();
    let info = {
        let mut inner = usb.lock();
        inner.opened.remove(&id);
        inner.present.get(&id).map(|(_, info)| info.clone())
    }
    .ok_or_else(|| "The controller was unplugged.".to_owned())?;
    let gcu = tauri::async_runtime::spawn_blocking(move || open_retrying(|| Gcu::open_info(&info)))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
    let (out, inp) = gcu.into_parts();
    let stop = Arc::new(AtomicBool::new(false));
    app.state::<Usb>()
        .lock()
        .opened
        .insert(id, Opened { out, stop: Arc::clone(&stop) });
    thread::spawn(move || pump(inp, &stop, &on_packet));
    Ok(())
}

#[tauri::command]
pub(crate) async fn usb_send(app: AppHandle, id: u32, data: Vec<u8>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let usb = app.state::<Usb>();
        let mut inner = usb.lock();
        let opened = inner
            .opened
            .get_mut(&id)
            .ok_or_else(|| "The controller isn't open.".to_owned())?;
        opened.out.send(&data).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
#[expect(
    clippy::needless_pass_by_value,
    reason = "Tauri hands commands their arguments by value"
)]
pub(crate) fn usb_close(app: AppHandle, id: u32) { app.state::<Usb>().lock().opened.remove(&id); }
