use std::time::{Duration, Instant};

use techchase_core::gcu;
use techchase_usb::gcu::Gcu;

use crate::{Fallible, seconds_arg};

const WAIT: Duration = Duration::from_millis(100);

pub(crate) fn run(args: &[String]) -> Fallible {
    let seconds = seconds_arg(args, 5.0)?;
    let mut gcu = Gcu::open()?;
    gcu.set_live(gcu::LIVE_TECHCHASE)?;
    let result = measure(&mut gcu, Duration::from_secs_f64(seconds));
    gcu.set_live(gcu::LIVE_RAW)?;
    result
}

fn measure(gcu: &mut Gcu, length: Duration) -> Fallible {
    let began = Instant::now();
    let (mut reports, mut dropped, mut other) = (0u32, 0u32, 0u32);
    let mut last_seq = None::<u8>;
    let mut last_at = None::<Instant>;
    let mut longest = Duration::ZERO;
    while began.elapsed() < length {
        let Some(p) = gcu.next_packet(WAIT)? else {
            say!("no report in {} ms", WAIT.as_millis());
            continue;
        };
        let Some(seq) = gcu::live_seq(&p) else {
            other += 1;
            continue;
        };
        let now = Instant::now();
        if let Some(prev) = last_at {
            longest = longest.max(now - prev);
        }
        if let Some(prev) = last_seq {
            dropped += u32::from(seq.wrapping_sub(prev).saturating_sub(1));
        }
        last_at = Some(now);
        last_seq = Some(seq);
        reports += 1;
    }
    let secs = began.elapsed().as_secs_f64();
    let expected = 1_000_000.0 / f64::from(gcu::LIVE_PERIOD_US);
    say!(
        "{reports} live reports in {secs:.1} s = {:.0} a second (the firmware sends {expected:.0}), {dropped} skipped by sequence, \
         longest gap {:.1} ms, {other} other packets",
        f64::from(reports) / secs,
        longest.as_secs_f64() * 1000.0
    );
    Ok(())
}
