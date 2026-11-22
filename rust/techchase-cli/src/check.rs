use std::time::Duration;

use techchase_core::analog::Cmd;
use techchase_core::codes::InputCode;
use techchase_core::gcu::MapEntry;
use techchase_core::layout::{self, MODIFIER};
use techchase_usb::gcu::Gcu;

use crate::Fallible;

const MIN_FW_VERSION: u32 = 1_700_000_000;
const STATS_WAIT: Duration = Duration::from_millis(300);

struct Checks {
    failures: usize,
}

impl Checks {
    fn check(&mut self, ok: bool, what: &str) {
        say!("{}  {what}", if ok { "PASS" } else { "FAIL" });
        if !ok {
            self.failures += 1;
        }
    }
}

fn find<'a>(entries: &'a [MapEntry], name: &str) -> Fallible<&'a MapEntry> {
    entries
        .iter()
        .find(|e| e.name == name)
        .ok_or_else(|| format!("no {name} in the button map").into())
}

fn current(gcu: &mut Gcu, name: &str) -> Fallible<MapEntry> { find(&gcu.map()?, name).cloned() }

fn remaps(c: &mut Checks, gcu: &mut Gcu, before: &[MapEntry]) -> Fallible {
    let zr = find(before, "ZR")?.clone();
    let x = find(before, "X")?.clone();
    let power = find(before, MODIFIER)?.clone();
    let x_name = x.gc_def.name();

    c.check(gcu.assign(zr.code, x.code, true)?, "ASSIGN ZR -> X accepted");
    let m = current(gcu, "ZR")?;
    c.check(
        m.gc_cur.name() == x_name && m.sw_cur == x.sw_def,
        "ZR now jumps in GameCube and Switch profiles",
    );
    c.check(
        layout::layout_of(&gcu.map()?).contains(&(zr.code, x.code)),
        "layout_of sees the change",
    );

    c.check(
        gcu.assign(zr.code, zr.code, true)?,
        "ASSIGN ZR -> ZR (own default) accepted",
    );
    let m = current(gcu, "ZR")?;
    c.check(m.gc_cur == m.gc_def, "ZR back to default");
    c.check(
        !gcu.assign(power.code, x.code, true)?,
        "Power refused by the firmware",
    );

    c.check(
        gcu.assign(zr.code, x.code, false)?,
        "ASSIGN ZR -> X without saving accepted",
    );
    c.check(
        current(gcu, "ZR")?.gc_cur.name() == x_name,
        "the unsaved change is live",
    );
    c.check(gcu.info()?.unsaved, "INFO reports unsaved changes");
    gcu.revert()?;
    let m = current(gcu, "ZR")?;
    c.check(m.gc_cur == m.gc_def, "REVERT puts ZR back to the saved layout");
    c.check(!gcu.info()?.unsaved, "nothing unsaved after REVERT");

    gcu.reset_all(false)?;
    c.check(
        gcu.info()?.unsaved,
        "RESET_ALL without saving leaves changes unsaved",
    );
    gcu.revert()?;
    c.check(
        layout::layout_of(&gcu.map()?) == layout::layout_of(before),
        "REVERT after RESET_ALL brings the saved layout back",
    );

    c.check(
        gcu.assign(zr.code, x.code, false)?,
        "ASSIGN ZR -> X without saving, again",
    );
    gcu.save()?;
    c.check(!gcu.info()?.unsaved, "SAVE clears the unsaved flag");
    gcu.revert()?;
    c.check(
        current(gcu, "ZR")?.gc_cur.name() == x_name,
        "a saved change survives REVERT",
    );

    c.check(gcu.assign(zr.code, zr.code, true)?, "ASSIGN ZR -> ZR, saving");
    c.check(
        gcu.assign(zr.code, x.code, false)?,
        "ASSIGN ZR -> X without saving, at once",
    );
    gcu.revert()?;
    let m = current(gcu, "ZR")?;
    c.check(
        m.gc_cur == m.gc_def,
        "a change sent right after a save isn't stored with it",
    );

    let mut swap = vec![(zr.code, x.code), (x.code, zr.code)];
    swap.sort_unstable();
    gcu.apply_layout(&swap, true)?;
    let after = layout::layout_of(&gcu.map()?);
    c.check(after == swap, &format!("profile apply round-trips ({after:?})"));
    Ok(())
}

fn analog_block(c: &mut Checks, gcu: &mut Gcu) -> Fallible {
    let block = gcu.analog_block()?;
    let a = techchase_core::analog::parse(&block)?;
    let notches = a.left.iter().filter(|s| s.enabled).count();
    c.check(
        notches >= 8,
        &format!(
            "analog block reads ({notches} notches on the main stick, calibrated {})",
            a.calibration_set
        ),
    );
    let l = gcu.capture(Cmd::CaptureLeft)?;
    let r = gcu.capture(Cmd::CaptureRight)?;
    c.check(
        [l.angle, l.distance, r.angle, r.distance].iter().all(|v| v.is_finite())
            && (0.0..360.0).contains(&l.angle),
        &format!(
            "stick capture replies (main {:.1}° {:.0}, c {:.1}° {:.0})",
            l.angle, l.distance, r.angle, r.distance
        ),
    );
    gcu.write_analog(&block)?;
    c.check(
        gcu.analog_block()? == block,
        "writing the analog block back leaves it byte for byte the same",
    );
    c.check(
        !gcu.info()?.unsaved,
        "a block write alone does not mark remaps unsaved",
    );
    Ok(())
}

fn run_checks(
    c: &mut Checks,
    gcu: &mut Gcu,
    original: &mut Option<Vec<(InputCode, InputCode)>>,
) -> Fallible {
    let device = gcu.device_info()?;
    say!(
        "device {} ({:04x}:{:04x}) board {} fw {:?}",
        gcu.product,
        gcu.vendor_id,
        gcu.product_id,
        device.name,
        device.fw_version
    );
    c.check(
        !device.name.is_empty() && device.fw_version.is_some_and(|v| v > MIN_FW_VERSION),
        "static device block read (name, firmware version)",
    );

    let i = gcu.info()?;
    c.check(
        i.proto == 2,
        &format!("techchase INFO reply, protocol {}", i.proto),
    );
    c.check(!i.unsaved, "nothing unsaved at the start");

    gcu.reset_stats()?;
    std::thread::sleep(STATS_WAIT);
    let s = gcu.stats()?;
    c.check(s.version >= 1, "STATS reply parses");

    let before = gcu.map()?;
    *original = Some(layout::layout_of(&before));
    let remappable = layout::remappable(&before).count();
    say!(
        "map: {} inputs, {remappable} remappable, layout now {:?}",
        before.len(),
        layout::layout_of(&before)
    );
    c.check(before.len() >= 20 && remappable >= 12, "MAP pages read");
    c.check(
        !layout::remappable(&before).any(|e| e.name == MODIFIER),
        "Power (the modifier) not offered",
    );

    remaps(c, gcu, &before)?;
    analog_block(c, gcu)
}

pub(crate) fn run(args: &[String]) -> Fallible {
    if !args.is_empty() {
        return Err("tc check takes no options".into());
    }
    let mut gcu = Gcu::open()?;
    say!("This remaps ZR and X for a moment, then puts your saved layout back.");
    let mut c = Checks { failures: 0 };
    let mut original = None;
    if let Err(e) = run_checks(&mut c, &mut gcu, &mut original) {
        say!("ERROR {e}");
        c.failures += 1;
    }
    if let Some(original) = original {
        let restored = gcu
            .apply_layout(&original, true)
            .and_then(|()| gcu.map())
            .map(|m| layout::layout_of(&m));
        match restored {
            Ok(back) => c.check(back == original, &format!("original layout restored ({back:?})")),
            Err(e) => c.check(false, &format!("restoring the original layout: {e}")),
        }
    }
    if c.failures == 0 {
        say!("all passed");
        Ok(())
    } else {
        Err(format!("{} FAILED", c.failures).into())
    }
}
