use std::collections::HashMap;
use std::sync::mpsc::{self, Receiver, Sender};
use std::thread;
use std::time::Duration;

use futures_lite::StreamExt;
use futures_lite::future::block_on;
use nusb::hotplug::HotplugEvent;
use nusb::{DeviceId, DeviceInfo, MaybeFuture};

use crate::adapter::is_adapter;
use crate::error::{Result, UsbError};
use crate::gcu::may_be_gcu;

pub const OPEN_TRIES: usize = 10;
pub const OPEN_RETRY: Duration = Duration::from_millis(100);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Kind {
    Gcu,
    Adapter,
    Other,
}

impl Kind {
    #[must_use]
    pub fn of(info: &DeviceInfo) -> Self {
        if is_adapter(info) {
            Self::Adapter
        } else if may_be_gcu(info) {
            Self::Gcu
        } else {
            Self::Other
        }
    }
}

#[derive(Debug)]
pub enum Event {
    Present(Kind, DeviceInfo),
    Arrived(Kind, DeviceInfo),
    Left(Kind, DeviceId),
}

fn forward(watch: nusb::hotplug::HotplugWatch, known: HashMap<DeviceId, Kind>, tx: &Sender<Event>) {
    let mut known = known;
    let mut watch = watch;
    while let Some(event) = block_on(watch.next()) {
        let sent = match event {
            HotplugEvent::Connected(info) => {
                let kind = Kind::of(&info);
                known.insert(info.id(), kind);
                tx.send(Event::Arrived(kind, info))
            }
            HotplugEvent::Disconnected(id) => {
                tx.send(Event::Left(known.remove(&id).unwrap_or(Kind::Other), id))
            }
        };
        if sent.is_err() {
            return;
        }
    }
}

pub fn watch() -> Result<Receiver<Event>> {
    let watch = nusb::watch_devices().map_err(UsbError::Watch)?;
    let (tx, rx) = mpsc::channel();
    let mut known = HashMap::new();
    for info in nusb::list_devices().wait().map_err(UsbError::List)? {
        let kind = Kind::of(&info);
        known.insert(info.id(), kind);
        if kind != Kind::Other && tx.send(Event::Present(kind, info)).is_err() {
            return Ok(rx);
        }
    }
    thread::spawn(move || forward(watch, known, &tx));
    Ok(rx)
}

pub fn open_retrying<T>(mut open: impl FnMut() -> Result<T>) -> Result<T> {
    let mut last = open();
    for _ in 1..OPEN_TRIES {
        if last.is_ok() {
            break;
        }
        thread::sleep(OPEN_RETRY);
        last = open();
    }
    last
}
