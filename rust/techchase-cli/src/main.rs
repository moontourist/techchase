macro_rules! say {
    ($($arg:tt)*) => {{
        use std::io::Write as _;
        writeln!(std::io::stdout(), $($arg)*).ok();
    }};
}

mod adapter_cmd;
mod check;
mod gcu_cmd;
mod live;
mod watch;

use std::io::Write as _;
use std::process::ExitCode;

type Fallible<T = ()> = Result<T, Box<dyn std::error::Error>>;

const USAGE: [&str; 13] = [
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
    "  tc watch [--seconds N]",
    "      Lists the GC Ultimates and adapters plugged in, then each one plugged in or out, and opens",
    "      each new one to show it can be used.",
];

fn usage() -> String { USAGE.join("\n") }

pub(crate) fn seconds_arg(args: &[String], default: f64) -> Fallible<f64> {
    let seconds = match args {
        [] => default,
        [flag, n] if flag == "--seconds" => n.parse().map_err(|e| format!("--seconds: {e}"))?,
        _ => return Err(usage().into()),
    };
    if !(seconds > 0.0 && seconds <= 3600.0) {
        return Err("--seconds is above 0 and at most 3600".into());
    }
    Ok(seconds)
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let result = match args.split_first() {
        Some((cmd, rest)) if cmd == "adapter" => adapter_cmd::run(rest),
        Some((cmd, rest)) if gcu_cmd::NAMES.contains(&cmd.as_str()) => gcu_cmd::run(cmd, rest),
        Some((cmd, rest)) if cmd == "check" => check::run(rest),
        Some((cmd, rest)) if cmd == "live" => live::run(rest),
        Some((cmd, rest)) if cmd == "watch" => watch::run(rest),
        _ => Err(usage().into()),
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            writeln!(std::io::stderr(), "{e}").ok();
            ExitCode::FAILURE
        }
    }
}
