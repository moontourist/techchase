use std::fs;
use std::time::Duration;

use techchase_core::analog::{self, Side, Slot};
use techchase_usb::gcu::Gcu;

use crate::Fallible;

const LET_GO: Duration = Duration::from_secs(2);

enum Action {
    Show,
    Backup(String),
    Restore(String),
    Reset,
}

fn parse(args: &[String]) -> Fallible<(Action, bool)> {
    let mut action = Action::Show;
    let mut save = false;
    let mut it = args.iter();
    while let Some(a) = it.next() {
        let mut file = || it.next().cloned().ok_or_else(|| format!("{a} needs a file"));
        match a.as_str() {
            "--backup" => action = Action::Backup(file()?),
            "--restore" => action = Action::Restore(file()?),
            "--reset" => action = Action::Reset,
            "--save" => save = true,
            other => return Err(format!("unknown option {other}").into()),
        }
    }
    Ok((action, save))
}

fn show_side(name: &str, slots: &[Slot], t: analog::StickTuning) {
    let notches: Vec<String> = slots
        .iter()
        .filter(|s| s.enabled)
        .map(|s| format!("{:.1}°→{:.0}° at {:.0}", s.in_angle, s.out_angle, s.in_distance))
        .collect();
    say!("{name}");
    say!("  notches   {}", notches.join(", "));
    say!(
        "  deadzone  {} (outer {})   snapback type {} intensity {}   curve {}   spring {}",
        t.deadzone,
        t.deadzone_outer,
        t.snapback_type,
        t.snapback_intensity,
        t.exp,
        if t.spring_tuned {
            "fitted to this stick"
        } else {
            "built-in"
        }
    );
}

fn show(block: &[u8]) -> Fallible {
    let a = analog::parse(block)?;
    say!(
        "centers   main ({}, {})   c ({}, {})   calibrated {}",
        a.centers.lx,
        a.centers.ly,
        a.centers.rx,
        a.centers.ry,
        a.calibration_set
    );
    show_side("main stick", &a.left, analog::tuning(block, Side::Left));
    show_side("c-stick", &a.right, analog::tuning(block, Side::Right));
    Ok(())
}

fn finish(gcu: &mut Gcu, save: bool) -> Fallible {
    if save {
        gcu.save()?;
        say!("Saved to the controller.");
    } else {
        say!(
            "Working now, not saved: unplug the controller to go back, or run again with --save to keep it."
        );
    }
    Ok(())
}

pub(crate) fn run(args: &[String]) -> Fallible {
    let (action, save) = parse(args)?;
    let mut gcu = Gcu::open()?;
    match action {
        Action::Show => show(&gcu.analog_block()?),
        Action::Backup(path) => {
            let block = gcu.analog_block()?;
            analog::parse(&block)?;
            fs::write(&path, &block)?;
            say!("Stick settings written to {path}.");
            Ok(())
        }
        Action::Restore(path) => {
            let block = fs::read(&path)?;
            analog::parse(&block)?;
            gcu.write_analog(&block)?;
            say!("Stick settings restored from {path}.");
            show(&gcu.analog_block()?)?;
            finish(&mut gcu, save)
        }
        Action::Reset => {
            say!(
                "Let go of both sticks. Their centers are measured in {} s.",
                LET_GO.as_secs()
            );
            std::thread::sleep(LET_GO);
            gcu.reset_sticks()?;
            say!("Sticks reset to the firmware's defaults.");
            show(&gcu.analog_block()?)?;
            finish(&mut gcu, save)
        }
    }
}
