pub use crate::codes::InputCode;
use crate::melee::FwAxis;

pub const MIN_LEN: usize = 41;
pub const INPUT_CODES: u8 = 36;
const CENTER: i32 = 2048;
const TC_GAME_AT: usize = 15;
const TC_PRE_AT: usize = 23;
const TC_PRESSES_AT: usize = 31;
const TC_LT_AT: usize = 36;
const TC_RT_AT: usize = 38;
const TC_SEQ_AT: usize = 40;
const RAW_AT: usize = 17;
const RAW_PRESSED: u8 = 0x80;
const RAW_LEVEL: u8 = 0x7f;
const RAW_SHIFT: u32 = 5;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Presses(u64);

impl Presses {
    #[must_use]
    pub const fn contains(self, code: InputCode) -> bool {
        code.0 < INPUT_CODES && self.0 & (1 << code.0) != 0
    }

    pub const fn insert(&mut self, code: InputCode) {
        if code.0 < INPUT_CODES {
            self.0 |= 1 << code.0;
        }
    }

    pub fn iter(self) -> impl Iterator<Item = InputCode> {
        (0..INPUT_CODES).map(InputCode).filter(move |c| self.contains(*c))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Sticks {
    pub lx: FwAxis,
    pub ly: FwAxis,
    pub rx: FwAxis,
    pub ry: FwAxis,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Techchase,
    Joysticks,
    Raw,
}

impl Kind {
    #[must_use]
    pub const fn id(self) -> u8 {
        match self {
            Self::Techchase => 253,
            Self::Joysticks => 254,
            Self::Raw => 255,
        }
    }

    #[must_use]
    pub const fn from_id(id: u8) -> Option<Self> {
        match id {
            253 => Some(Self::Techchase),
            254 => Some(Self::Joysticks),
            255 => Some(Self::Raw),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Report {
    pub kind: Kind,
    pub game: Sticks,
    pub pre: Sticks,
    pub presses: Presses,
    pub lt: u16,
    pub rt: u16,
    pub seq: Option<u8>,
}

fn u16be(p: &[u8], at: usize) -> u16 {
    p.get(at..at + 2)
        .and_then(|b| <[u8; 2]>::try_from(b).ok())
        .map_or(0, u16::from_be_bytes)
}

fn centered(p: &[u8], at: usize) -> FwAxis { FwAxis(i32::from(u16be(p, at)) - CENTER) }

fn sticks_at(p: &[u8], at: usize) -> Sticks {
    Sticks {
        lx: centered(p, at),
        ly: centered(p, at + 2),
        rx: centered(p, at + 4),
        ry: centered(p, at + 6),
    }
}

fn raw_byte(p: &[u8], code: InputCode) -> u8 {
    p.get(RAW_AT + usize::from(code.0)).copied().unwrap_or(0)
}

fn raw_level(p: &[u8], code: InputCode) -> u16 {
    u16::from(raw_byte(p, code) & RAW_LEVEL) << RAW_SHIFT
}

fn raw_half(p: &[u8], pos: InputCode, neg: InputCode) -> FwAxis {
    FwAxis((i32::from(raw_level(p, pos)) - i32::from(raw_level(p, neg))) / 2)
}

#[must_use]
pub fn parse(p: &[u8]) -> Option<Report> {
    if p.len() < MIN_LEN {
        return None;
    }
    match Kind::from_id(*p.first()?)? {
        Kind::Techchase => {
            let mut presses = Presses::default();
            for code in (0..INPUT_CODES).map(InputCode) {
                let byte = p.get(TC_PRESSES_AT + usize::from(code.0 >> 3)).copied().unwrap_or(0);
                if byte & (1 << (code.0 & 7)) != 0 {
                    presses.insert(code);
                }
            }
            Some(Report {
                kind: Kind::Techchase,
                game: sticks_at(p, TC_GAME_AT),
                pre: sticks_at(p, TC_PRE_AT),
                presses,
                lt: u16be(p, TC_LT_AT),
                rt: u16be(p, TC_RT_AT),
                seq: p.get(TC_SEQ_AT).copied(),
            })
        }
        Kind::Joysticks => Some(Report {
            kind: Kind::Joysticks,
            game: sticks_at(p, TC_PRE_AT),
            pre: sticks_at(p, TC_GAME_AT),
            presses: Presses::default(),
            lt: 0,
            rt: 0,
            seq: None,
        }),
        Kind::Raw => {
            let mut presses = Presses::default();
            for code in (0..INPUT_CODES).map(InputCode) {
                if raw_byte(p, code) & RAW_PRESSED != 0 {
                    presses.insert(code);
                }
            }
            let game = Sticks {
                lx: raw_half(p, InputCode::LX_RIGHT, InputCode::LX_LEFT),
                ly: raw_half(p, InputCode::LY_UP, InputCode::LY_DOWN),
                rx: raw_half(p, InputCode::RX_RIGHT, InputCode::RX_LEFT),
                ry: raw_half(p, InputCode::RY_UP, InputCode::RY_DOWN),
            };
            Some(Report {
                kind: Kind::Raw,
                game,
                pre: game,
                presses,
                lt: raw_level(p, InputCode::LT_ANALOG),
                rt: raw_level(p, InputCode::RT_ANALOG),
                seq: None,
            })
        }
    }
}

#[must_use]
pub fn encode(r: &Report) -> [u8; 64] {
    let mut p = [0u8; 64];
    let mut put = |at: usize, v: i32| {
        let c = u16::try_from((v + CENTER).clamp(0, i32::from(u16::MAX))).unwrap_or(u16::MAX);
        if let Some(dst) = p.get_mut(at..at + 2) {
            dst.copy_from_slice(&c.to_be_bytes());
        }
    };
    for (at, s) in [(TC_GAME_AT, r.game), (TC_PRE_AT, r.pre)] {
        put(at, s.lx.0);
        put(at + 2, s.ly.0);
        put(at + 4, s.rx.0);
        put(at + 6, s.ry.0);
    }
    put(TC_LT_AT, i32::from(r.lt) - CENTER);
    put(TC_RT_AT, i32::from(r.rt) - CENTER);
    p[0] = Kind::Techchase.id();
    for code in r.presses.iter() {
        if let Some(b) = p.get_mut(TC_PRESSES_AT + usize::from(code.0 >> 3)) {
            *b |= 1 << (code.0 & 7);
        }
    }
    p[TC_SEQ_AT] = r.seq.unwrap_or(0);
    p
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sticks(lx: i32, ly: i32, rx: i32, ry: i32) -> Sticks {
        Sticks {
            lx: FwAxis(lx),
            ly: FwAxis(ly),
            rx: FwAxis(rx),
            ry: FwAxis(ry),
        }
    }

    #[test]
    fn techchase_round_trip() {
        let mut presses = Presses::default();
        presses.insert(InputCode(0));
        presses.insert(InputCode::L);
        presses.insert(InputCode::RY_DOWN);
        let r = Report {
            kind: Kind::Techchase,
            game: sticks(1500, -2048, 0, 2047),
            pre: sticks(1490, -2000, 3, 2040),
            presses,
            lt: 4095,
            rt: 12,
            seq: Some(201),
        };
        assert_eq!(parse(&encode(&r)), Some(r));
        assert_eq!(presses.iter().collect::<Vec<_>>(), vec![
            InputCode(0),
            InputCode::L,
            InputCode::RY_DOWN
        ]);
    }

    #[test]
    fn joysticks_swap_game_and_pre() {
        let mut p = encode(&Report {
            kind: Kind::Techchase,
            game: sticks(10, 20, 30, 40),
            pre: sticks(1, 2, 3, 4),
            presses: Presses::default(),
            lt: 0,
            rt: 0,
            seq: None,
        });
        p[0] = Kind::Joysticks.id();
        let r = parse(&p).unwrap();
        assert_eq!(
            (r.game, r.pre, r.seq),
            (sticks(1, 2, 3, 4), sticks(10, 20, 30, 40), None)
        );
    }

    #[test]
    fn raw_levels() {
        let mut p = [0u8; 64];
        p[0] = Kind::Raw.id();
        p[RAW_AT + 27] = 0x80 | 0x7f;
        p[RAW_AT + 30] = 0x40;
        p[RAW_AT + 11] = 0x20;
        p[RAW_AT + 2] = 0x80;
        let r = parse(&p).unwrap();
        assert_eq!((r.game.lx, r.game.ly), (FwAxis(2032), FwAxis(-1024)));
        assert_eq!(r.lt, 1024);
        assert!(r.presses.contains(InputCode(2)) && r.presses.contains(InputCode::LX_RIGHT));
        assert!(!r.presses.contains(InputCode::LY_DOWN));
    }

    #[test]
    fn refuses_short_and_unknown() {
        assert_eq!(parse(&[253; 40]), None);
        assert_eq!(parse(&[0xc0; 64]), None);
        assert!(!Presses::default().contains(InputCode(40)));
    }
}
