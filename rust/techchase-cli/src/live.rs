use std::io::Write;
use std::time::{Duration, Instant};

use techchase_core::gcu;

use crate::gcu_link::Link;

const WAIT: Duration = Duration::from_millis(100);

pub fn run(args: &[String]) -> Result<(), String> {
    let seconds: f64 = match args {
        [] => 5.0,
        [flag, n] if flag == "--seconds" => n.parse().map_err(|e| format!("--seconds: {e}"))?,
        _ => return Err("usage: tc live [--seconds N]".to_owned()),
    };
    if !(seconds > 0.0 && seconds <= 3600.0) {
        return Err("--seconds is above 0 and at most 3600".to_owned());
    }
    let mut link = Link::open()?;
    link.set_live(gcu::LIVE_TECHCHASE)?;
    let result = measure(&mut link, Duration::from_secs_f64(seconds));
    link.set_live(gcu::LIVE_RAW)?;
    result
}

fn measure(link: &mut Link, length: Duration) -> Result<(), String> {
    let began = Instant::now();
    let (mut reports, mut dropped, mut other) = (0u32, 0u32, 0u32);
    let mut last_seq = None::<u8>;
    let mut last_at = None::<Instant>;
    let mut longest = Duration::ZERO;
    while began.elapsed() < length {
        let Some(p) = link.next_packet(WAIT)? else {
            writeln!(std::io::stdout(), "no report in {} ms", WAIT.as_millis()).ok();
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
    writeln!(
        std::io::stdout(),
        "{reports} live reports in {secs:.1} s = {:.0} a second (the firmware sends {expected:.0}), {dropped} skipped by sequence, \
         longest gap {:.1} ms, {other} other packets",
        f64::from(reports) / secs,
        longest.as_secs_f64() * 1000.0
    )
    .ok();
    Ok(())
}
