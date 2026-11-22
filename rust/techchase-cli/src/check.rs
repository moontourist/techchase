use std::time::Duration;

use techchase_core::analog::{self, Cmd};
use techchase_core::gcu::{self, Command, Info, MapEntry, Revert, Stats};
use techchase_core::layout::{self, MODIFIER};

use crate::gcu_cmd::read_map;
use crate::gcu_link::Link;

const MIN_FW_VERSION: u32 = 1_700_000_000;
const REVERT_TRIES: usize = 25;
const REVERT_WAIT: Duration = Duration::from_millis(40);
const STATS_WAIT: Duration = Duration::from_millis(300);

struct Checks {
    failures: usize,
}

impl Checks {
    fn check(&mut self, ok: bool, what: &str) {
        println!("{}  {what}", if ok { "PASS" } else { "FAIL" });
        if !ok {
            self.failures += 1;
        }
    }
}

fn info(link: &mut Link) -> Result<Info, String> {
    Info::parse(&link.command(Command::Info, &[])?).map_err(|e| e.to_string())
}

fn assign(link: &mut Link, src: u8, target: u8, save: bool) -> Result<bool, String> {
    let reply = link.command(Command::Assign, &gcu::assign_args(src, target, save))?;
    gcu::parse_ok(&reply, Command::Assign).map_err(|e| e.to_string())
}

fn reset_all(link: &mut Link, save: bool) -> Result<(), String> {
    link.command(Command::ResetAll, &[gcu::save_flag(save)])
        .map(|_| ())
}

fn save(link: &mut Link) -> Result<(), String> {
    let reply = link.command(Command::Save, &[])?;
    if gcu::parse_ok(&reply, Command::Save).map_err(|e| e.to_string())? {
        Ok(())
    } else {
        Err("the controller did not save".to_owned())
    }
}

fn revert(link: &mut Link) -> Result<(), String> {
    for _ in 0..REVERT_TRIES {
        match gcu::parse_revert(&link.command(Command::Revert, &[])?).map_err(|e| e.to_string())? {
            Revert::Done => return Ok(()),
            Revert::NoStore => {
                return Err("this controller can't reload its saved layout".to_owned());
            }
            Revert::Busy | Revert::Unknown(_) => std::thread::sleep(REVERT_WAIT),
        }
    }
    Err("the controller is still writing its last save".to_owned())
}

fn apply_layout(link: &mut Link, pairs: &[(u8, u8)]) -> Result<(), String> {
    reset_all(link, true)?;
    for &(src, target) in pairs {
        if !assign(link, src, target, true)? {
            return Err(format!("the controller refused remapping input {src}"));
        }
    }
    Ok(())
}

fn find<'a>(entries: &'a [MapEntry], name: &str) -> Result<&'a MapEntry, String> {
    entries
        .iter()
        .find(|e| e.name == name)
        .ok_or_else(|| format!("no {name} in the button map"))
}

fn current(link: &mut Link, name: &str) -> Result<MapEntry, String> {
    find(&read_map(link)?, name).cloned()
}

fn remaps(c: &mut Checks, link: &mut Link, before: &[MapEntry]) -> Result<(), String> {
    let zr = find(before, "ZR")?.clone();
    let x = find(before, "X")?.clone();
    let power = find(before, MODIFIER)?.clone();
    let x_name = layout::code_name(x.gc_def);

    c.check(
        assign(link, zr.code, x.code, true)?,
        "ASSIGN ZR -> X accepted",
    );
    let m = current(link, "ZR")?;
    c.check(
        layout::code_name(m.gc_cur) == x_name && m.sw_cur == x.sw_def,
        "ZR now jumps in GameCube and Switch profiles",
    );
    c.check(
        layout::layout_of(&read_map(link)?).contains(&(zr.code, x.code)),
        "layout_of sees the change",
    );

    c.check(
        assign(link, zr.code, zr.code, true)?,
        "ASSIGN ZR -> ZR (own default) accepted",
    );
    let m = current(link, "ZR")?;
    c.check(m.gc_cur == m.gc_def, "ZR back to default");
    c.check(
        !assign(link, power.code, x.code, true)?,
        "Power refused by the firmware",
    );

    c.check(
        assign(link, zr.code, x.code, false)?,
        "ASSIGN ZR -> X without saving accepted",
    );
    c.check(
        layout::code_name(current(link, "ZR")?.gc_cur) == x_name,
        "the unsaved change is live",
    );
    c.check(info(link)?.unsaved, "INFO reports unsaved changes");
    revert(link)?;
    let m = current(link, "ZR")?;
    c.check(
        m.gc_cur == m.gc_def,
        "REVERT puts ZR back to the saved layout",
    );
    c.check(!info(link)?.unsaved, "nothing unsaved after REVERT");

    reset_all(link, false)?;
    c.check(
        info(link)?.unsaved,
        "RESET_ALL without saving leaves changes unsaved",
    );
    revert(link)?;
    c.check(
        layout::layout_of(&read_map(link)?) == layout::layout_of(before),
        "REVERT after RESET_ALL brings the saved layout back",
    );

    c.check(
        assign(link, zr.code, x.code, false)?,
        "ASSIGN ZR -> X without saving, again",
    );
    save(link)?;
    c.check(!info(link)?.unsaved, "SAVE clears the unsaved flag");
    revert(link)?;
    c.check(
        layout::code_name(current(link, "ZR")?.gc_cur) == x_name,
        "a saved change survives REVERT",
    );

    c.check(
        assign(link, zr.code, zr.code, true)?,
        "ASSIGN ZR -> ZR, saving",
    );
    c.check(
        assign(link, zr.code, x.code, false)?,
        "ASSIGN ZR -> X without saving, at once",
    );
    revert(link)?;
    let m = current(link, "ZR")?;
    c.check(
        m.gc_cur == m.gc_def,
        "a change sent right after a save isn't stored with it",
    );

    let mut swap = vec![(zr.code, x.code), (x.code, zr.code)];
    swap.sort_unstable();
    apply_layout(link, &swap)?;
    let after = layout::layout_of(&read_map(link)?);
    c.check(
        after == swap,
        &format!("profile apply round-trips ({after:?})"),
    );
    Ok(())
}

fn analog_block(c: &mut Checks, link: &mut Link) -> Result<(), String> {
    let block = link
        .read_block(gcu::ID_READ_CONFIG_BLOCK, analog::CFG_BLOCK)?
        .unwrap_or_default();
    let a = analog::parse(&block).map_err(|e| e.to_string())?;
    let notches = a.left.iter().filter(|s| s.enabled).count();
    c.check(
        notches >= 8,
        &format!(
            "analog block reads ({notches} notches on the main stick, calibrated {})",
            a.calibration_set
        ),
    );
    let mut capture = |cmd: Cmd| -> Result<analog::Capture, String> {
        analog::parse_capture(&link.config_command(analog::CFG_BLOCK, cmd.code())?)
            .ok_or_else(|| "a short capture reply".to_owned())
    };
    let l = capture(Cmd::CaptureLeft)?;
    let r = capture(Cmd::CaptureRight)?;
    c.check(
        [l.angle, l.distance, r.angle, r.distance]
            .iter()
            .all(|v| v.is_finite())
            && (0.0..360.0).contains(&l.angle),
        &format!(
            "stick capture replies (main {:.1}° {:.0}, c {:.1}° {:.0})",
            l.angle, l.distance, r.angle, r.distance
        ),
    );
    link.write_block(analog::CFG_BLOCK, &block)?;
    let again = link
        .read_block(gcu::ID_READ_CONFIG_BLOCK, analog::CFG_BLOCK)?
        .unwrap_or_default();
    c.check(
        again == block,
        "writing the analog block back leaves it byte for byte the same",
    );
    c.check(
        !info(link)?.unsaved,
        "a block write alone does not mark remaps unsaved",
    );
    Ok(())
}

fn run_checks(
    c: &mut Checks,
    link: &mut Link,
    original: &mut Option<Vec<(u8, u8)>>,
) -> Result<(), String> {
    let device = gcu::parse_static_device(
        &link
            .read_block(gcu::ID_READ_STATIC_BLOCK, 0)?
            .unwrap_or_default(),
    );
    println!(
        "device {} ({:04x}:{:04x}) board {} fw {:?}",
        link.product, link.vendor_id, link.product_id, device.name, device.fw_version
    );
    c.check(
        !device.name.is_empty() && device.fw_version.is_some_and(|v| v > MIN_FW_VERSION),
        "static device block read (name, firmware version)",
    );

    let i = info(link)?;
    c.check(
        i.proto == 2,
        &format!("techchase INFO reply, protocol {}", i.proto),
    );
    c.check(!i.unsaved, "nothing unsaved at the start");

    link.command(Command::StatsReset, &[])?;
    std::thread::sleep(STATS_WAIT);
    let s = Stats::parse(&link.command(Command::Stats, &[])?).map_err(|e| e.to_string())?;
    c.check(s.version >= 1, "STATS reply parses");

    let before = read_map(link)?;
    *original = Some(layout::layout_of(&before));
    let remappable = layout::remappable(&before).count();
    println!(
        "map: {} inputs, {remappable} remappable, layout now {:?}",
        before.len(),
        layout::layout_of(&before)
    );
    c.check(before.len() >= 20 && remappable >= 12, "MAP pages read");
    c.check(
        !layout::remappable(&before).any(|e| e.name == MODIFIER),
        "Power (the modifier) not offered",
    );

    remaps(c, link, &before)?;
    analog_block(c, link)
}

pub fn run(args: &[String]) -> Result<(), String> {
    if !args.is_empty() {
        return Err("tc check takes no options".to_owned());
    }
    let mut link = Link::open()?;
    println!("This remaps ZR and X for a moment, then puts your saved layout back.");
    let mut c = Checks { failures: 0 };
    let mut original = None;
    if let Err(e) = run_checks(&mut c, &mut link, &mut original) {
        println!("ERROR {e}");
        c.failures += 1;
    }
    if let Some(original) = original {
        let restored = apply_layout(&mut link, &original)
            .and_then(|()| read_map(&mut link))
            .map(|m| layout::layout_of(&m));
        match restored {
            Ok(back) => c.check(
                back == original,
                &format!("original layout restored ({back:?})"),
            ),
            Err(e) => c.check(false, &format!("restoring the original layout: {e}")),
        }
    }
    if c.failures == 0 {
        println!("all passed");
        Ok(())
    } else {
        Err(format!("{} FAILED", c.failures))
    }
}
