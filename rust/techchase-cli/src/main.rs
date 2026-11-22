mod check;
mod gcu_cmd;
mod gcu_link;
mod live;

use std::io::Write;
use std::process::ExitCode;
use std::time::{Duration, Instant};

use nusb::MaybeFuture;
use nusb::transfer::{In, Interrupt, Out};
use techchase_core::adapter::{self, PortKind};

const ADAPTER_INTERFACE: u8 = 0;
const ADAPTER_IN: u8 = 0x81;
const ADAPTER_OUT: u8 = 0x02;
const SHOW_EVERY: Duration = Duration::from_millis(200);
const READ_TIMEOUT: Duration = Duration::from_millis(100);

struct Options {
    seconds: f64,
    queue: usize,
    port: usize,
}

fn usage() -> String {
    [
        "usage:",
        "  tc info                 the controller, its firmware and techchase settings",
        "  tc stats [--reset]      input age at hand-off (late-latch)",
        "  tc map                  the button layout",
        "  tc live [--seconds N]   the live input stream's rate and dropped reports",
        "  tc check                the app's protocol checks (remaps ZR and X, then restores the layout)",
        "      These talk to a GC Ultimate on techchase firmware. Close the app's tab first.",
        "  tc adapter [--seconds N] [--queue K] [--port 1-4]",
        "      Reads a GameCube adapter (Lossless or Nintendo's) the way Dolphin does, with RAW_IO and K",
        "      reads in flight, shows the port live and ends with the poll rate. Close Dolphin first.",
    ]
    .join("
")
}

fn parse_args(args: &[String]) -> Result<Options, String> {
    let mut o = Options {
        seconds: 5.0,
        queue: 4,
        port: 1,
    };
    let mut it = args.iter();
    while let Some(a) = it.next() {
        let mut value = |name: &str| it.next().ok_or_else(|| format!("{name} needs a value"));
        match a.as_str() {
            "--seconds" => o.seconds = value(a)?.parse().map_err(|e| format!("--seconds: {e}"))?,
            "--queue" => o.queue = value(a)?.parse().map_err(|e| format!("--queue: {e}"))?,
            "--port" => o.port = value(a)?.parse().map_err(|e| format!("--port: {e}"))?,
            other => return Err(format!("unknown option {other}\n{}", usage())),
        }
    }
    if !(1..=adapter::PORTS).contains(&o.port) {
        return Err("--port is 1 to 4".to_owned());
    }
    if !(1..=64).contains(&o.queue) {
        return Err("--queue is 1 to 64".to_owned());
    }
    if !(o.seconds > 0.0 && o.seconds <= 3600.0) {
        return Err("--seconds is above 0 and at most 3600".to_owned());
    }
    Ok(o)
}

fn kind_name(kind: PortKind) -> String {
    match kind {
        PortKind::Empty => "empty".to_owned(),
        PortKind::Wired => "wired".to_owned(),
        PortKind::Wireless => "wireless".to_owned(),
        PortKind::Other(k) => format!("type {k}"),
    }
}

fn open_adapter() -> Result<nusb::Interface, String> {
    let info = nusb::list_devices()
        .wait()
        .map_err(|e| format!("listing USB devices: {e}"))?
        .find(|d| d.vendor_id() == adapter::VENDOR_ID && d.product_id() == adapter::PRODUCT_ID)
        .ok_or(
            "no GameCube adapter (057e:0337) found. Is it plugged in, and in Wii U / PC mode?",
        )?;
    writeln!(
        std::io::stdout(),
        "{}{}",
        info.product_string().unwrap_or("GameCube adapter"),
        info.manufacturer_string()
            .map_or_else(String::new, |m| format!(" by {m}"))
    )
    .ok();
    let device = info
        .open()
        .wait()
        .map_err(|e| format!("opening the adapter: {e} (close Dolphin)"))?;
    let interface = device
        .claim_interface(ADAPTER_INTERFACE)
        .wait()
        .map_err(|e| {
            format!(
                "claiming the adapter: {e} (close Dolphin; the adapter needs the WinUSB driver)"
            )
        })?;

    let mut out = interface
        .endpoint::<Interrupt, Out>(ADAPTER_OUT)
        .map_err(|e| format!("adapter OUT endpoint: {e}"))?;
    let mut start = out.allocate(1);
    start.extend_from_slice(&[adapter::START_POLLING]);
    out.transfer_blocking(start, Duration::from_millis(500))
        .status
        .map_err(|e| format!("starting the adapter: {e}"))?;

    Ok(interface)
}

fn show_port(number: usize, p: &adapter::Port) -> std::io::Result<()> {
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

fn adapter_cmd(o: &Options) -> Result<(), String> {
    let interface = open_adapter()?;
    let mut inp = interface
        .endpoint::<Interrupt, In>(ADAPTER_IN)
        .map_err(|e| format!("adapter IN endpoint: {e}"))?;
    let packet = inp.max_packet_size();
    for _ in 0..o.queue {
        let buf = inp.allocate(packet);
        inp.submit(buf);
    }

    let port_index = o.port - 1;
    let began = Instant::now();
    let until = began + Duration::from_secs_f64(o.seconds);
    let mut last = None::<Instant>;
    let mut last_shown = began;
    let (mut reports, mut bad, mut gaps_over_2ms) = (0u64, 0u64, 0u64);
    let mut longest = Duration::ZERO;
    let mut kinds_seen = Vec::new();

    while Instant::now() < until {
        let Some(done) = inp.wait_next_complete(READ_TIMEOUT) else {
            writeln!(
                std::io::stdout(),
                "\nno report in {} ms",
                READ_TIMEOUT.as_millis()
            )
            .ok();
            continue;
        };
        let now = Instant::now();
        let status = done.status;
        let data = done
            .buffer
            .get(..done.actual_len)
            .map_or_else(Vec::new, <[u8]>::to_vec);
        let mut buf = done.buffer;
        buf.clear();
        inp.submit(buf);
        if let Err(e) = status {
            return Err(format!("reading the adapter: {e}"));
        }
        if let Some(prev) = last {
            let gap = now - prev;
            longest = longest.max(gap);
            if gap > Duration::from_millis(2) && reports > 10 {
                gaps_over_2ms += 1;
            }
        }
        last = Some(now);
        match adapter::parse_report(&data) {
            Err(_) => bad += 1,
            Ok(ports) => {
                reports += 1;
                let Some(p) = ports.get(port_index) else {
                    continue;
                };
                if !kinds_seen.contains(&p.kind) {
                    kinds_seen.push(p.kind);
                }
                if now - last_shown >= SHOW_EVERY {
                    last_shown = now;
                    let shown = show_port(o.port, p);
                    if shown.is_err() {
                        break;
                    }
                }
            }
        }
    }
    inp.cancel_all();
    let secs = began.elapsed().as_secs_f64();
    writeln!(std::io::stdout()).ok();
    writeln!(std::io::stdout(),
        "{reports} reports in {secs:.1} s = {:.0} a second, {bad} malformed, longest gap {:.2} ms, {gaps_over_2ms} gaps over 2 ms",
        f64::from(u32::try_from(reports).unwrap_or(u32::MAX)) / secs,
        longest.as_secs_f64() * 1000.0
    ).ok();
    writeln!(
        std::io::stdout(),
        "port {} was: {}",
        o.port,
        kinds_seen
            .iter()
            .map(|k| kind_name(*k))
            .collect::<Vec<_>>()
            .join(", ")
    )
    .ok();
    Ok(())
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let result = match args.split_first() {
        Some((cmd, rest)) if cmd == "adapter" => parse_args(rest).and_then(|o| adapter_cmd(&o)),
        Some((cmd, rest)) if gcu_cmd::NAMES.contains(&cmd.as_str()) => gcu_cmd::run(cmd, rest),
        Some((cmd, rest)) if cmd == "check" => check::run(rest),
        Some((cmd, rest)) if cmd == "live" => live::run(rest),
        _ => Err(usage()),
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("{e}");
            ExitCode::FAILURE
        }
    }
}
