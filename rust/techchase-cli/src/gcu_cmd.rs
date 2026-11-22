use std::time::Duration;

use techchase_core::codes::GcCode;
use techchase_usb::UsbError;
use techchase_usb::gcu::Gcu;

use crate::Fallible;

pub(crate) const NAMES: [&str; 3] = ["info", "stats", "map"];

const STATS_SETTLE: Duration = Duration::from_secs(1);

fn code_name(code: GcCode) -> String {
    code.name().map_or_else(
        || {
            if code.0 < 0 {
                "-".to_owned()
            } else {
                format!("#{}", code.0)
            }
        },
        str::to_owned,
    )
}

pub(crate) fn run(cmd: &str, args: &[String]) -> Fallible {
    let reset = match args {
        [] => false,
        [flag] if cmd == "stats" && flag == "--reset" => true,
        _ => {
            return Err(format!(
                "tc {cmd} takes no options{}",
                if cmd == "stats" { " but --reset" } else { "" }
            )
            .into());
        }
    };
    let mut gcu = Gcu::open()?;
    match cmd {
        "info" => info(&mut gcu),
        "stats" => stats(&mut gcu, reset),
        _ => map(&mut gcu),
    }
}

fn info(gcu: &mut Gcu) -> Fallible {
    let device = gcu.device_info()?;
    say!(
        "controller  {} ({:04x}:{:04x})  board name {}",
        gcu.product,
        gcu.vendor_id,
        gcu.product_id,
        device.name
    );
    if let Some(fw) = device.fw_version {
        say!("firmware    {fw}");
    }
    let i = match gcu.info() {
        Ok(i) => i,
        Err(UsbError::NoReply) => {
            say!("techchase   not present (official firmware)");
            return Ok(());
        }
        Err(e) => return Err(e.into()),
    };
    say!(
        "techchase   protocol {}, late-latch {}, USB mode {}, quick remap {}{}",
        i.proto,
        if i.latch_on { "on" } else { "OFF" },
        i.report_format.name(),
        if i.quick_remap { "ON" } else { "off" },
        if i.unsaved { ", unsaved changes" } else { "" }
    );
    say!("latch       {}", i.latch_mode.describe());
    Ok(())
}

fn stats(gcu: &mut Gcu, reset: bool) -> Fallible {
    if reset {
        gcu.reset_stats()?;
        std::thread::sleep(STATS_SETTLE);
    }
    let s = gcu.stats()?;
    say!(
        "mode     {}{}",
        s.mode.describe(),
        if s.latch_off {
            "  [late-latch switched OFF: stock timing]"
        } else {
            ""
        }
    );
    if s.count == 0 {
        say!("         no hand-offs measured yet (is a game/emulator polling the controller?)");
        return Ok(());
    }
    say!(
        "input age at hand-off  avg {:5} us   min {:5}   max {:5}   ({} reports, {} late)",
        s.age_avg_us,
        s.age_min_us,
        s.age_max_us,
        s.count,
        s.misses
    );
    let what = if s.mode.tracks_host_phase() {
        "host poll phase"
    } else {
        "poll period"
    };
    say!(
        "schedule  lead {} us (guard {})   {what} {} us   input read {} us (max {})",
        s.lead_us,
        s.guard_us,
        s.phase_us,
        s.read_us,
        s.read_max_us
    );
    Ok(())
}

fn map(gcu: &mut Gcu) -> Fallible {
    let entries = gcu.map()?;
    say!("{:<10} {:<10} {:<10}", "button", "sends", "default");
    for e in &entries {
        say!(
            "{:<10} {:<10} {:<10}{}",
            e.name,
            code_name(e.gc_cur),
            code_name(e.gc_def),
            if e.remapped() { "  changed" } else { "" }
        );
    }
    say!(
        "{} buttons, {} changed",
        entries.len(),
        entries.iter().filter(|e| e.remapped()).count()
    );
    Ok(())
}
