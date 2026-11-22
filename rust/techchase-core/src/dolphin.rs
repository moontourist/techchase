use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use std::{env, fmt, fs, io};

use serde::Serialize;

pub const SI_NOTHING: i32 = 0;
pub const SI_STANDARD: i32 = 6;
pub const SI_ADAPTER: i32 = 12;
pub const PORTS: usize = 4;
const SI_DEFAULT: [i32; PORTS] = [SI_STANDARD, SI_NOTHING, SI_NOTHING, SI_NOTHING];
const CONTROLLER_NAMES: [&str; 4] = ["gcu", "gc ultimate", "hoja", "sinput"];
const DIRECT_INPUT: &str = "DInput";

pub const SINPUT_PROFILE: [(&str, &str); 22] = [
    ("Buttons/A", "`Button 0`"),
    ("Buttons/B", "`Button 2`"),
    ("Buttons/X", "`Button 1`"),
    ("Buttons/Y", "`Button 3`"),
    ("Buttons/Z", "`Button 11`"),
    ("Buttons/Start", "`Button 16`"),
    ("Main Stick/Up", "`Axis Y-`"),
    ("Main Stick/Down", "`Axis Y+`"),
    ("Main Stick/Left", "`Axis X-`"),
    ("Main Stick/Right", "`Axis X+`"),
    ("C-Stick/Up", "`Axis Zr-`"),
    ("C-Stick/Down", "`Axis Zr+`"),
    ("C-Stick/Left", "`Axis Z-`"),
    ("C-Stick/Right", "`Axis Z+`"),
    ("Triggers/L", "`Button 12`"),
    ("Triggers/R", "`Button 13`"),
    ("Triggers/L-Analog", "`Axis Xr-+`"),
    ("Triggers/R-Analog", "`Axis Yr-+`"),
    ("D-Pad/Up", "`Button 4`"),
    ("D-Pad/Down", "`Button 5`"),
    ("D-Pad/Left", "`Button 6`"),
    ("D-Pad/Right", "`Button 7`"),
];

const SENDS: [(&str, &str); 12] = [
    ("`Button 0`", "A"),
    ("`Button 2`", "B"),
    ("`Button 1`", "X"),
    ("`Button 3`", "Y"),
    ("`Button 11`", "Z"),
    ("`Button 16`", "Start"),
    ("`Button 12`", "L"),
    ("`Button 13`", "R"),
    ("`Button 4`", "D-Pad Up"),
    ("`Button 5`", "D-Pad Down"),
    ("`Button 6`", "D-Pad Left"),
    ("`Button 7`", "D-Pad Right"),
];

pub type Section = HashMap<String, String>;
pub type Ini = HashMap<String, Section>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Install {
    pub id: String,
    pub label: String,
    pub path: PathBuf,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Reads {
    Gcu,
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Wrong {
    pub input: String,
    pub has: String,
    pub want: String,
    pub gets: Option<&'static str>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Profile {
    pub reads: Reads,
    pub device: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backend: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub checkable: Option<bool>,
    pub wrong: Vec<Wrong>,
}

impl Profile {
    #[must_use]
    pub fn checkable(&self) -> bool { self.checkable == Some(true) }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Port {
    pub port: usize,
    pub si: i32,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profile: Option<Profile>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Found {
    pub id: String,
    pub label: String,
    pub path: String,
    pub ports: Vec<Port>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Report {
    pub installs: Vec<Found>,
    pub dolphin_running: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Fixed {
    pub path: String,
    pub backup: String,
}

#[derive(Debug)]
pub enum FixError {
    NoInstall(String),
    BadPort(usize),
    DolphinOpen,
    NotDirectInput(usize),
    Io(io::Error),
}

impl fmt::Display for FixError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NoInstall(id) => write!(f, "no Dolphin install called {id}"),
            Self::BadPort(_) => f.write_str("port must be 1 to 4"),
            Self::DolphinOpen => f.write_str(
                "Dolphin is open. Close it first: it rewrites this file when it closes.",
            ),
            Self::NotDirectInput(port) => {
                write!(f, "port {port} does not read the controller over DirectInput")
            }
            Self::Io(e) => e.fmt(f),
        }
    }
}

impl std::error::Error for FixError {}

impl From<io::Error> for FixError {
    fn from(e: io::Error) -> Self { Self::Io(e) }
}

#[must_use]
pub fn default_installs() -> Vec<Install> {
    let appdata = PathBuf::from(env::var_os("APPDATA").unwrap_or_default());
    let home = PathBuf::from(
        env::var_os("USERPROFILE").or_else(|| env::var_os("HOME")).unwrap_or_default(),
    );
    let install = |id: &str, label: &str, path: PathBuf| Install {
        id: id.to_owned(),
        label: label.to_owned(),
        path,
    };
    vec![
        install(
            "slippi",
            "Slippi Dolphin (netplay)",
            appdata.join("Slippi Launcher").join("netplay").join("User"),
        ),
        install(
            "dolphin",
            "Dolphin",
            home.join("Documents").join("Dolphin Emulator"),
        ),
        install("dolphin-appdata", "Dolphin", appdata.join("Dolphin Emulator")),
    ]
}

pub fn installs_in(root: &Path) -> io::Result<Vec<Install>> {
    let mut names: Vec<String> = fs::read_dir(root)?
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    Ok(names
        .into_iter()
        .map(|n| Install {
            id: n.clone(),
            label: n.clone(),
            path: root.join(n),
        })
        .collect())
}

#[must_use]
pub fn parse_ini(text: &str) -> Ini {
    let mut sections = Ini::new();
    let mut current: Option<String> = None;
    for line in text.lines() {
        let line = line.trim_end_matches('\r');
        let header = line
            .trim_end()
            .strip_prefix('[')
            .and_then(|l| l.strip_suffix(']'))
            .filter(|name| !name.is_empty());
        if let Some(name) = header {
            sections.entry(name.to_owned()).or_default();
            current = Some(name.to_owned());
        } else if let (Some(name), Some((key, value))) = (&current, line.split_once(" = ")) {
            sections
                .entry(name.clone())
                .or_default()
                .insert(key.trim().to_owned(), value.to_owned());
        }
    }
    sections
}

fn read_ini(path: &Path) -> Ini {
    fs::read(path).map_or_else(|_| Ini::new(), |b| parse_ini(&String::from_utf8_lossy(&b)))
}

fn config(dir: &Path, file: &str) -> PathBuf { dir.join("Config").join(file) }

#[must_use]
pub fn port_devices(user_dir: &Path) -> [i32; PORTS] {
    let ini = read_ini(&config(user_dir, "Dolphin.ini"));
    let core = ini.get("Core");
    let mut out = SI_DEFAULT;
    for (i, slot) in out.iter_mut().enumerate() {
        if let Some(raw) = core.and_then(|c| c.get(&format!("SIDevice{i}"))) {
            *slot = raw.trim().parse().unwrap_or(-1);
        }
    }
    out
}

fn si_name(si: i32) -> String {
    match si {
        SI_NOTHING => "Nothing".to_owned(),
        SI_STANDARD => "Standard Controller".to_owned(),
        SI_ADAPTER => "GameCube Adapter for Wii U".to_owned(),
        other => format!("other ({other})"),
    }
}

fn sends(binding: &str) -> Option<&'static str> {
    SENDS.iter().find(|(b, _)| *b == binding).map(|(_, name)| *name)
}

fn unquote(binding: &str) -> String { binding.trim_matches('`').to_owned() }

#[must_use]
pub fn check_profile(pad: &Section) -> Profile {
    let device = pad.get("Device").cloned().unwrap_or_default();
    let lower = device.to_lowercase();
    if !CONTROLLER_NAMES.iter().any(|n| lower.contains(n)) {
        return Profile {
            reads: Reads::Other,
            device,
            backend: None,
            checkable: None,
            wrong: Vec::new(),
        };
    }
    let backend = device.split('/').next().unwrap_or_default().to_owned();
    if !device.starts_with(&format!("{DIRECT_INPUT}/")) {
        return Profile {
            reads: Reads::Gcu,
            device,
            backend: Some(backend),
            checkable: Some(false),
            wrong: Vec::new(),
        };
    }
    let wrong = SINPUT_PROFILE
        .iter()
        .filter_map(|&(key, want)| {
            let has = pad.get(key).map_or("", String::as_str);
            (has != want).then(|| {
                let shown = unquote(has);
                Wrong {
                    input: key.to_owned(),
                    has: if shown.is_empty() {
                        "nothing".to_owned()
                    } else {
                        shown
                    },
                    want: unquote(want),
                    gets: sends(has),
                }
            })
        })
        .collect();
    Profile {
        reads: Reads::Gcu,
        device,
        backend: Some(backend),
        checkable: Some(true),
        wrong,
    }
}

#[must_use]
pub fn check(installs: &[Install], dolphin_running: bool) -> Report {
    let found = installs
        .iter()
        .filter(|i| config(&i.path, "Dolphin.ini").exists())
        .map(|i| {
            let pads = read_ini(&config(&i.path, "GCPadNew.ini"));
            let ports = port_devices(&i.path)
                .into_iter()
                .enumerate()
                .map(|(n, si)| {
                    let port = n + 1;
                    let profile = (si == SI_STANDARD).then(|| {
                        check_profile(pads.get(&format!("GCPad{port}")).unwrap_or(&Section::new()))
                    });
                    Port {
                        port,
                        si,
                        name: si_name(si),
                        profile,
                    }
                })
                .collect();
            Found {
                id: i.id.clone(),
                label: i.label.clone(),
                path: i.path.display().to_string(),
                ports,
            }
        })
        .collect();
    Report {
        installs: found,
        dolphin_running,
    }
}

#[must_use]
pub fn dolphin_running() -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt as _;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        std::process::Command::new("tasklist")
            .args(["/FO", "CSV", "/NH"])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .is_ok_and(|o| String::from_utf8_lossy(&o.stdout).to_lowercase().contains("dolphin"))
    }
    #[cfg(not(windows))]
    {
        false
    }
}

#[must_use]
pub fn rewrite_port(text: &str, port: usize) -> Option<String> {
    let nl = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let mut lines: Vec<String> = text.lines().map(str::to_owned).collect();
    let section = format!("[GCPad{port}]");
    let start = lines.iter().position(|l| *l == section)? + 1;
    let end = lines
        .iter()
        .skip(start)
        .position(|l| l.starts_with('['))
        .map_or(lines.len(), |j| start + j);
    let mut todo: Vec<(&str, &str)> = SINPUT_PROFILE.to_vec();
    for line in lines.iter_mut().take(end).skip(start) {
        let Some((key, _)) = line.split_once(" = ") else {
            continue;
        };
        let key = key.trim().to_owned();
        if let Some(at) = todo.iter().position(|(k, _)| *k == key) {
            let (k, v) = todo.remove(at);
            *line = format!("{k} = {v}");
        }
    }
    let added = todo.into_iter().map(|(k, v)| format!("{k} = {v}"));
    lines.splice(end..end, added);
    Some(lines.join(nl) + nl)
}

pub fn write_profile(
    installs: &[Install],
    id: &str,
    port: usize,
    dolphin_running: bool,
    stamp: &str,
) -> Result<Fixed, FixError> {
    let install = installs
        .iter()
        .find(|i| i.id == id)
        .ok_or_else(|| FixError::NoInstall(id.to_owned()))?;
    if !(1..=PORTS).contains(&port) {
        return Err(FixError::BadPort(port));
    }
    if dolphin_running {
        return Err(FixError::DolphinOpen);
    }
    let path = config(&install.path, "GCPadNew.ini");
    let pad = read_ini(&path).remove(&format!("GCPad{port}")).unwrap_or_default();
    if !check_profile(&pad).checkable() {
        return Err(FixError::NotDirectInput(port));
    }
    let mut backup = path.clone().into_os_string();
    backup.push(format!(".techchase-{stamp}.bak"));
    let backup = PathBuf::from(backup);
    fs::copy(&path, &backup)?;
    let text = String::from_utf8_lossy(&fs::read(&path)?).into_owned();
    let rewritten = rewrite_port(&text, port).ok_or(FixError::NotDirectInput(port))?;
    fs::write(&path, rewritten)?;
    Ok(Fixed {
        path: path.display().to_string(),
        backup: backup.display().to_string(),
    })
}

#[must_use]
pub fn stamp(secs_since_epoch: u64) -> String {
    let days = secs_since_epoch / 86_400;
    let rem = secs_since_epoch % 86_400;
    let (y, m, d) = civil_from_days(i64::try_from(days).unwrap_or(0));
    format!(
        "{y:04}{m:02}{d:02}-{:02}{:02}{:02}",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60
    )
}

#[must_use]
pub fn stamp_now() -> String {
    stamp(SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs()))
}

const fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    (y, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    const DOLPHIN_INI: &str = "[General]\nISOPath0 = x\n[Core]\nSIDevice0 = 6\nSIDevice1 = 12\nSIDevice2 = 6\n[Interface]\n";

    const OLD_PROFILE: &str = "[GCPad1]
Device = DInput/0/GCU 1
Buttons/A = `Button 1`
Buttons/B = `Button 2`
Buttons/X = `Button 0`
Buttons/Y = `Button 3`
Buttons/Z = `Button 7`
Buttons/Start = `Button 9`
Main Stick/Up = `Axis Y-`
Main Stick/Modifier = LSHIFT
Main Stick/Modifier/Range = 50.000000000000000
C-Stick/Up = `Axis Z-`
D-Pad/Up = `Button 12`
D-Pad/Right = `Button 13`
Buttons/Threshold = 0.0000000000000000
[GCPad2]
Device = XInput/0/Gamepad
Buttons/A = `Button A`
[GCPad3]
Device = SDL/0/GCU 1
Buttons/A = `Button 0`
";

    struct Dir(PathBuf);

    impl Drop for Dir {
        fn drop(&mut self) { fs::remove_dir_all(&self.0).ok(); }
    }

    fn crlf(s: &str) -> String { s.replace('\n', "\r\n") }

    fn setup() -> (Dir, Vec<Install>) {
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let root =
            env::temp_dir().join(format!("techchase-dolphin-{}-{nanos}", std::process::id()));
        let user = root.join("slippi").join("Config");
        fs::create_dir_all(&user).unwrap();
        fs::create_dir_all(root.join("empty")).unwrap();
        fs::write(user.join("Dolphin.ini"), crlf(DOLPHIN_INI)).unwrap();
        fs::write(user.join("GCPadNew.ini"), crlf(OLD_PROFILE)).unwrap();
        let installs = installs_in(&root).unwrap();
        (Dir(root), installs)
    }

    fn port1(report: &Report) -> &Profile { report.installs[0].ports[0].profile.as_ref().unwrap() }

    #[test]
    fn reads_installs_and_ports() {
        let (_dir, installs) = setup();
        let r = check(&installs, false);
        assert_eq!(r.installs.iter().map(|i| i.id.as_str()).collect::<Vec<_>>(), [
            "slippi"
        ]);
        let ports = &r.installs[0].ports;
        assert_eq!(ports.iter().map(|p| p.si).collect::<Vec<_>>(), [6, 12, 6, 0]);
        assert!(ports[1].profile.is_none());
        let p3 = ports[2].profile.as_ref().unwrap();
        assert_eq!(
            (p3.reads, p3.backend.as_deref(), p3.checkable()),
            (Reads::Gcu, Some("SDL"), false)
        );
    }

    #[test]
    fn lists_what_is_wrong() {
        let (_dir, installs) = setup();
        let r = check(&installs, false);
        let p1 = port1(&r);
        assert!(p1.checkable() && p1.backend.as_deref() == Some("DInput"));
        let wrong = |input: &str| p1.wrong.iter().find(|w| w.input == input);
        let a = wrong("Buttons/A").unwrap();
        assert_eq!((a.has.as_str(), a.gets), ("Button 1", Some("X")));
        assert_eq!(wrong("D-Pad/Up").unwrap().gets, Some("L"));
        assert!(wrong("Buttons/B").is_none() && wrong("Main Stick/Up").is_none());
        assert_eq!(wrong("Triggers/L-Analog").unwrap().has, "nothing");
    }

    #[test]
    fn refuses_bad_fixes() {
        let (_dir, installs) = setup();
        assert!(matches!(
            write_profile(&installs, "slippi", 3, false, "s"),
            Err(FixError::NotDirectInput(3))
        ));
        assert!(matches!(
            write_profile(&installs, "nope", 1, false, "s"),
            Err(FixError::NoInstall(_))
        ));
        assert!(matches!(
            write_profile(&installs, "slippi", 5, false, "s"),
            Err(FixError::BadPort(5))
        ));
        assert!(matches!(
            write_profile(&installs, "slippi", 1, true, "s"),
            Err(FixError::DolphinOpen)
        ));
    }

    #[test]
    fn rewrites_one_port() {
        let (_dir, installs) = setup();
        let slippi = installs.iter().find(|i| i.id == "slippi").unwrap();
        let path = config(&slippi.path, "GCPadNew.ini");
        let before = fs::read_to_string(&path).unwrap();
        let out = write_profile(&installs, "slippi", 1, false, "20261121-120000").unwrap();
        let after = fs::read_to_string(&out.path).unwrap();
        assert!(out.backup.ends_with("GCPadNew.ini.techchase-20261121-120000.bak"));
        assert_eq!(fs::read_to_string(&out.backup).unwrap(), before);
        assert_eq!(port1(&check(&installs, false)).wrong, []);
        assert!(
            after.contains("Device = DInput/0/GCU 1\r\n")
                && after.contains("Main Stick/Modifier = LSHIFT\r\n")
        );
        assert_eq!(after.split("[GCPad2]").nth(1), before.split("[GCPad2]").nth(1));
        assert!(!after.replace("\r\n", "").contains('\n'));
        assert_eq!(
            after.split("[GCPad2]").next().unwrap().matches("Buttons/A = ").count(),
            1
        );
    }

    #[test]
    fn stamps_dates() {
        assert_eq!(stamp(0), "19700101-000000");
        assert_eq!(stamp(1_795_306_561), "20261122-001601");
        assert_eq!(stamp(951_782_400), "20000229-000000");
    }
}
