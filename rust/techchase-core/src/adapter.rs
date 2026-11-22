use std::fmt;

pub const VENDOR_ID: u16 = 0x057e;
pub const PRODUCT_ID: u16 = 0x0337;
pub const REPORT_ID: u8 = 0x21;
pub const REPORT_LEN: usize = 37;
pub const START_POLLING: u8 = 0x13;
pub const PORTS: usize = 4;
const PORT_LEN: usize = 9;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PortKind {
    Empty,
    Wired,
    Wireless,
    Other(u8),
}

impl PortKind {
    #[must_use]
    pub const fn from_status(status: u8) -> Self {
        match status >> 4 {
            0 => Self::Empty,
            1 => Self::Wired,
            2 => Self::Wireless,
            other => Self::Other(other),
        }
    }

    #[must_use]
    pub const fn connected(self) -> bool { !matches!(self, Self::Empty) }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Button {
    A,
    B,
    X,
    Y,
    DLeft,
    DRight,
    DDown,
    DUp,
    Start,
    Z,
    R,
    L,
}

impl Button {
    pub const ALL: [Self; 12] = [
        Self::A,
        Self::B,
        Self::X,
        Self::Y,
        Self::Z,
        Self::L,
        Self::R,
        Self::Start,
        Self::DUp,
        Self::DDown,
        Self::DLeft,
        Self::DRight,
    ];

    const fn mask(self) -> u16 {
        match self {
            Self::A => 1,
            Self::B => 1 << 1,
            Self::X => 1 << 2,
            Self::Y => 1 << 3,
            Self::DLeft => 1 << 4,
            Self::DRight => 1 << 5,
            Self::DDown => 1 << 6,
            Self::DUp => 1 << 7,
            Self::Start => 1 << 8,
            Self::Z => 1 << 9,
            Self::R => 1 << 10,
            Self::L => 1 << 11,
        }
    }

    #[must_use]
    pub const fn name(self) -> &'static str {
        match self {
            Self::A => "A",
            Self::B => "B",
            Self::X => "X",
            Self::Y => "Y",
            Self::DLeft => "D-Left",
            Self::DRight => "D-Right",
            Self::DDown => "D-Down",
            Self::DUp => "D-Up",
            Self::Start => "Start",
            Self::Z => "Z",
            Self::R => "R",
            Self::L => "L",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Buttons(u16);

impl Buttons {
    #[must_use]
    pub const fn from_bytes(first: u8, second: u8) -> Self {
        Self(u16::from_le_bytes([first, second]))
    }

    #[must_use]
    pub const fn pressed(self, button: Button) -> bool { self.0 & button.mask() != 0 }

    pub fn iter(self) -> impl Iterator<Item = Button> {
        Button::ALL.into_iter().filter(move |b| self.pressed(*b))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Stick {
    pub x: u8,
    pub y: u8,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Pad {
    pub buttons: Buttons,
    pub main: Stick,
    pub c: Stick,
    pub l: u8,
    pub r: u8,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Port {
    pub kind: PortKind,
    pub pad: Pad,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReportError {
    Length(usize),
    Id(u8),
}

impl fmt::Display for ReportError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Length(n) => {
                write!(f, "an adapter report is {REPORT_LEN} bytes, this one is {n}")
            }
            Self::Id(id) => write!(
                f,
                "an adapter report starts with {REPORT_ID:#04x}, this one with {id:#04x}"
            ),
        }
    }
}

impl std::error::Error for ReportError {}

pub fn parse_report(report: &[u8]) -> Result<[Port; PORTS], ReportError> {
    let Some((&id, body)) = report.split_first() else {
        return Err(ReportError::Length(0));
    };
    if report.len() != REPORT_LEN {
        return Err(ReportError::Length(report.len()));
    }
    if id != REPORT_ID {
        return Err(ReportError::Id(id));
    }
    let mut ports = [Port {
        kind: PortKind::Empty,
        pad: Pad::centered(),
    }; PORTS];
    let (chunks, _) = body.as_chunks::<PORT_LEN>();
    for (port, &[status, b1, b2, sx, sy, cx, cy, l, r]) in ports.iter_mut().zip(chunks) {
        *port = Port {
            kind: PortKind::from_status(status),
            pad: Pad {
                buttons: Buttons::from_bytes(b1, b2),
                main: Stick { x: sx, y: sy },
                c: Stick { x: cx, y: cy },
                l,
                r,
            },
        };
    }
    Ok(ports)
}

impl Pad {
    #[must_use]
    pub const fn centered() -> Self {
        Self {
            buttons: Buttons(0),
            main: Stick { x: 128, y: 128 },
            c: Stick { x: 128, y: 128 },
            l: 0,
            r: 0,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn report(port1: [u8; PORT_LEN]) -> [u8; REPORT_LEN] {
        let mut r = [0u8; REPORT_LEN];
        r[0] = REPORT_ID;
        r[1..=PORT_LEN].copy_from_slice(&port1);
        r[1 + PORT_LEN] = 0x10;
        r
    }

    #[test]
    fn reads_port_one() {
        let ports = parse_report(&report([
            0x14,
            0x01 | 0x80,
            0x01 | 0x08,
            200,
            60,
            128,
            127,
            30,
            255,
        ]))
        .unwrap();
        let p = ports[0];
        assert_eq!(p.kind, PortKind::Wired);
        assert!(p.pad.buttons.pressed(Button::A) && p.pad.buttons.pressed(Button::DUp));
        assert!(p.pad.buttons.pressed(Button::Start) && p.pad.buttons.pressed(Button::L));
        assert!(!p.pad.buttons.pressed(Button::B) && !p.pad.buttons.pressed(Button::Z));
        assert_eq!(p.pad.main, Stick { x: 200, y: 60 });
        assert_eq!((p.pad.l, p.pad.r), (30, 255));
        assert_eq!(ports[1].kind, PortKind::Wired);
        assert_eq!(ports[2].kind, PortKind::Empty);
    }

    #[test]
    fn button_order_is_stable() {
        let b = Buttons::from_bytes(0xff, 0x0f);
        assert_eq!(b.iter().count(), 12);
        assert_eq!(b.iter().next(), Some(Button::A));
    }

    #[test]
    fn refuses_bad_reports() {
        assert_eq!(parse_report(&[]), Err(ReportError::Length(0)));
        assert_eq!(parse_report(&[REPORT_ID; 36]), Err(ReportError::Length(36)));
        let mut r = report([0; PORT_LEN]);
        r[0] = 0x22;
        assert_eq!(parse_report(&r), Err(ReportError::Id(0x22)));
    }

    #[test]
    fn wireless_and_unknown_kinds() {
        assert_eq!(PortKind::from_status(0x22), PortKind::Wireless);
        assert_eq!(PortKind::from_status(0x34), PortKind::Other(3));
        assert!(!PortKind::from_status(0x04).connected());
    }
}
