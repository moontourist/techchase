use std::io::Write as _;
use std::time::{Duration, Instant};

use techchase_core::adapter::{self, Port, PortKind};
use techchase_usb::adapter::{Adapter, DEFAULT_QUEUE};

use crate::Fallible;

const SHOW_EVERY: Duration = Duration::from_millis(200);
const READ_TIMEOUT: Duration = Duration::from_millis(100);
const GAP_NOTED: Duration = Duration::from_millis(2);
const WARMUP_REPORTS: u64 = 10;

struct Options {
    seconds: f64,
    queue: usize,
    port: usize,
}

fn parse_args(args: &[String]) -> Fallible<Options> {
    let mut o = Options {
        seconds: 5.0,
        queue: DEFAULT_QUEUE,
        port: 1,
    };
    let mut it = args.iter();
    while let Some(a) = it.next() {
        let mut value = |name: &str| it.next().ok_or_else(|| format!("{name} needs a value"));
        match a.as_str() {
            "--seconds" => o.seconds = value(a)?.parse().map_err(|e| format!("--seconds: {e}"))?,
            "--queue" => o.queue = value(a)?.parse().map_err(|e| format!("--queue: {e}"))?,
            "--port" => o.port = value(a)?.parse().map_err(|e| format!("--port: {e}"))?,
            other => return Err(format!("unknown option {other}").into()),
        }
    }
    if !(1..=adapter::PORTS).contains(&o.port) {
        return Err("--port is 1 to 4".into());
    }
    if !(1..=64).contains(&o.queue) {
        return Err("--queue is 1 to 64".into());
    }
    if !(o.seconds > 0.0 && o.seconds <= 3600.0) {
        return Err("--seconds is above 0 and at most 3600".into());
    }
    Ok(o)
}

pub(crate) fn kind_name(kind: PortKind) -> String {
    match kind {
        PortKind::Empty => "empty".to_owned(),
        PortKind::Wired => "wired".to_owned(),
        PortKind::Wireless => "wireless".to_owned(),
        PortKind::Other(k) => format!("type {k}"),
    }
}

fn show_port(number: usize, p: &Port) -> std::io::Result<()> {
    let pressed: Vec<&str> = p.pad.buttons.iter().map(adapter::Button::name).collect();
    let buttons = if pressed.is_empty() {
        "-".to_owned()
    } else {
        pressed.join(" ")
    };
    let mut out = std::io::stdout().lock();
    write!(
        out,
        "\rport {number} {:8}  main ({:3},{:3})  c ({:3},{:3})  L {:3} R {:3}  {buttons:<28}",
        kind_name(p.kind),
        p.pad.main.x,
        p.pad.main.y,
        p.pad.c.x,
        p.pad.c.y,
        p.pad.l,
        p.pad.r,
    )?;
    out.flush()
}

pub(crate) fn run(args: &[String]) -> Fallible {
    let o = parse_args(args)?;
    let mut ad = Adapter::open(o.queue)?;
    say!(
        "{}{}",
        ad.product,
        ad.maker.as_ref().map_or_else(String::new, |m| format!(" by {m}"))
    );

    let port_index = o.port - 1;
    let began = Instant::now();
    let until = began + Duration::from_secs_f64(o.seconds);
    let mut last = None::<Instant>;
    let mut last_shown = began;
    let (mut reports, mut bad, mut gaps_noted) = (0u64, 0u64, 0u64);
    let mut longest = Duration::ZERO;
    let mut kinds_seen = Vec::new();

    while Instant::now() < until {
        let Some(reading) = ad.read(READ_TIMEOUT)? else {
            say!("\nno report in {} ms", READ_TIMEOUT.as_millis());
            continue;
        };
        if let Some(prev) = last {
            let gap = reading.at - prev;
            longest = longest.max(gap);
            if gap > GAP_NOTED && reports > WARMUP_REPORTS {
                gaps_noted += 1;
            }
        }
        last = Some(reading.at);
        let Ok(ports) = reading.ports else {
            bad += 1;
            continue;
        };
        reports += 1;
        let Some(p) = ports.get(port_index) else { continue };
        if !kinds_seen.contains(&p.kind) {
            kinds_seen.push(p.kind);
        }
        if reading.at - last_shown >= SHOW_EVERY {
            last_shown = reading.at;
            if show_port(o.port, p).is_err() {
                break;
            }
        }
    }
    let secs = began.elapsed().as_secs_f64();
    say!();
    say!(
        "{reports} reports in {secs:.1} s = {:.0} a second, {bad} malformed, longest gap {:.2} ms, {gaps_noted} gaps over {} ms",
        f64::from(u32::try_from(reports).unwrap_or(u32::MAX)) / secs,
        longest.as_secs_f64() * 1000.0,
        GAP_NOTED.as_millis()
    );
    say!(
        "port {} was: {}",
        o.port,
        kinds_seen.iter().map(|k| kind_name(*k)).collect::<Vec<_>>().join(", ")
    );
    Ok(())
}
