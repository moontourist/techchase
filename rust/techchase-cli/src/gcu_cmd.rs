use std::time::Duration;

use techchase_core::gcu::{self, Command, Info, MapEntry, Stats};
use techchase_core::layout;

use crate::gcu_link::Link;

pub const NAMES: [&str; 3] = ["info", "stats", "map"];

const STATS_SETTLE: Duration = Duration::from_secs(1);

pub fn format_name(id: u8) -> String {
    match id {
        0 => "Switch Pro".to_owned(),
        1 => "XInput".to_owned(),
        2 => "Slippi (GC adapter)".to_owned(),
        3 => "GameCube port".to_owned(),
        4 => "N64".to_owned(),
        5 => "SNES".to_owned(),
        6 => "SInput".to_owned(),
        7 => "Wii".to_owned(),
        other => format!("#{other}"),
    }
}

pub fn latch_name(mode: u8) -> &'static str {
    match mode {
        0 => "Off",
        1 => "Learning the host's timing (stock timing meanwhile)",
        2 => "Late-latch active",
        3 => "Polls not steady (stock timing)",
        4 => "Poll-locked",
        _ => "?",
    }
}

fn code_name(code: i8) -> String {
    layout::code_name(code).map_or_else(
        || {
            if code < 0 {
                "-".to_owned()
            } else {
                format!("#{code}")
            }
        },
        str::to_owned,
    )
}

pub fn run(cmd: &str, args: &[String]) -> Result<(), String> {
    let reset = match args {
        [] => false,
        [flag] if cmd == "stats" && flag == "--reset" => true,
        _ => {
            return Err(format!(
                "tc {cmd} takes no options{}",
                if cmd == "stats" { " but --reset" } else { "" }
            ));
        }
    };
    let mut link = Link::open()?;
    match cmd {
        "info" => info(&mut link),
        "stats" => stats(&mut link, reset),
        _ => map(&mut link),
    }
}

fn info(link: &mut Link) -> Result<(), String> {
    let block = link
        .read_block(gcu::ID_READ_STATIC_BLOCK, 0)?
        .unwrap_or_default();
    let device = gcu::parse_static_device(&block);
    println!(
        "controller  {} ({:04x}:{:04x})  board name {}",
        link.product, link.vendor_id, link.product_id, device.name
    );
    if let Some(fw) = device.fw_version {
        println!("firmware    {fw}");
    }
    let Ok(reply) = link.command(Command::Info, &[]) else {
        println!("techchase   not present (official firmware)");
        return Ok(());
    };
    let i = Info::parse(&reply).map_err(|e| e.to_string())?;
    println!(
        "techchase   protocol {}, late-latch {}, USB mode {}, quick remap {}{}",
        i.proto,
        if i.latch_on { "on" } else { "OFF" },
        format_name(i.report_format),
        if i.quick_remap { "ON" } else { "off" },
        if i.unsaved { ", unsaved changes" } else { "" }
    );
    println!("latch       {}", latch_name(i.latch_mode));
    Ok(())
}

fn stats(link: &mut Link, reset: bool) -> Result<(), String> {
    if reset {
        link.command(Command::StatsReset, &[])?;
        std::thread::sleep(STATS_SETTLE);
    }
    let s = Stats::parse(&link.command(Command::Stats, &[])?).map_err(|e| e.to_string())?;
    println!(
        "mode     {}{}",
        latch_name(s.mode),
        if s.latch_off {
            "  [late-latch switched OFF: stock timing]"
        } else {
            ""
        }
    );
    if s.count == 0 {
        println!("         no hand-offs measured yet (is a game/emulator polling the controller?)");
        return Ok(());
    }
    println!(
        "input age at hand-off  avg {:5} us   min {:5}   max {:5}   ({} reports, {} late)",
        s.age_avg_us, s.age_min_us, s.age_max_us, s.count, s.misses
    );
    let what = if matches!(s.mode, 1 | 2) {
        "host poll phase"
    } else {
        "poll period"
    };
    println!(
        "schedule  lead {} us (guard {})   {what} {} us   input read {} us (max {})",
        s.lead_us, s.guard_us, s.phase_us, s.read_us, s.read_max_us
    );
    Ok(())
}

pub fn read_map(link: &mut Link) -> Result<Vec<MapEntry>, String> {
    let mut entries = Vec::new();
    for page in 0..gcu::MAP_PAGES {
        let reply = link.command(Command::Map, &[page])?;
        if gcu::map_page_count(&reply).map_err(|e| e.to_string())? == 0 {
            break;
        }
        entries.extend(gcu::parse_map_page(&reply, page).map_err(|e| e.to_string())?);
    }
    Ok(entries)
}

fn map(link: &mut Link) -> Result<(), String> {
    let entries = read_map(link)?;
    println!("{:<10} {:<10} {:<10}", "button", "sends", "default");
    for e in &entries {
        println!(
            "{:<10} {:<10} {:<10}{}",
            e.name,
            code_name(e.gc_cur),
            code_name(e.gc_def),
            if e.remapped() { "  changed" } else { "" }
        );
    }
    println!(
        "{} buttons, {} changed",
        entries.len(),
        entries.iter().filter(|e| e.remapped()).count()
    );
    Ok(())
}
