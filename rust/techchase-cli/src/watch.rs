use std::sync::mpsc::RecvTimeoutError;
use std::time::{Duration, Instant};

use nusb::DeviceInfo;
use techchase_usb::adapter::{Adapter, DEFAULT_QUEUE};
use techchase_usb::gcu::Gcu;
use techchase_usb::hotplug::{self, Event, Kind, open_retrying};

use crate::{Fallible, seconds_arg};

const READ_WAIT: Duration = Duration::from_millis(100);

fn label(kind: Kind) -> &'static str {
    match kind {
        Kind::Gcu => "GC Ultimate",
        Kind::Adapter => "GameCube adapter",
        Kind::Other => "device",
    }
}

fn try_open(kind: Kind, info: &DeviceInfo) -> String {
    match kind {
        Kind::Gcu => match open_retrying(|| Gcu::open_info(info))
            .and_then(|mut g| g.info().map(|i| (g, i)))
        {
            Ok((g, i)) => format!(
                "opened {}: late-latch {}, {}",
                g.product,
                if i.latch_on { "on" } else { "off" },
                i.report_format.name()
            ),
            Err(e) => format!("can't use it: {e}"),
        },
        Kind::Adapter => match open_retrying(|| Adapter::open_info(info, DEFAULT_QUEUE)) {
            Ok(mut a) => match a.read(READ_WAIT) {
                Ok(Some(_)) => format!("opened {}, reports flowing", a.product),
                Ok(None) => format!("opened {}, but no report yet", a.product),
                Err(e) => format!("opened, then {e}"),
            },
            Err(e) => format!("can't use it: {e}"),
        },
        Kind::Other => String::new(),
    }
}

pub(crate) fn run(args: &[String]) -> Fallible {
    let seconds = seconds_arg(args, 60.0)?;
    let until = Instant::now() + Duration::from_secs_f64(seconds);
    let events = hotplug::watch()?;
    say!("Watching for {seconds:.0} s. Plug things in and out.");
    loop {
        let left = until.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return Ok(());
        }
        match events.recv_timeout(left) {
            Ok(Event::Present(kind, info)) => {
                say!(
                    "present  {} {:04x}:{:04x}  {}",
                    label(kind),
                    info.vendor_id(),
                    info.product_id(),
                    try_open(kind, &info)
                );
            }
            Ok(Event::Arrived(Kind::Other, _) | Event::Left(Kind::Other, _)) => {}
            Ok(Event::Arrived(kind, info)) => {
                say!(
                    "plugged  {} {:04x}:{:04x}  {}",
                    label(kind),
                    info.vendor_id(),
                    info.product_id(),
                    try_open(kind, &info)
                );
            }
            Ok(Event::Left(kind, _)) => say!("removed  {}", label(kind)),
            Err(RecvTimeoutError::Timeout) => return Ok(()),
            Err(RecvTimeoutError::Disconnected) => return Err("the USB watcher stopped".into()),
        }
    }
}
