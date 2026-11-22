use std::fmt;

pub const CFG_BLOCK: u8 = 2;
pub const BLOCK_SIZE: usize = 1024;
pub const SLOT_COUNT: usize = 16;
const SLOT_SIZE: usize = 21;
const CENTERS_AT: usize = 2;
const LEFT_SLOTS_AT: usize = 10;
const RIGHT_SLOTS_AT: usize = LEFT_SLOTS_AT + SLOT_SIZE * SLOT_COUNT;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Cmd {
    Refresh,
    CalibrateStart,
    CalibrateStop,
    CaptureLeft,
    CaptureRight,
}

impl Cmd {
    #[must_use]
    pub const fn code(self) -> u8 {
        match self {
            Self::Refresh => 0,
            Self::CalibrateStart => 1,
            Self::CalibrateStop => 2,
            Self::CaptureLeft => 3,
            Self::CaptureRight => 4,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Side {
    Left,
    Right,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Slot {
    pub in_angle: f32,
    pub out_angle: f32,
    pub deadzone: f32,
    pub in_distance: f32,
    pub out_distance: f32,
    pub enabled: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Centers {
    pub lx: u16,
    pub ly: u16,
    pub rx: u16,
    pub ry: u16,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Analog {
    pub version: u8,
    pub calibration_set: bool,
    pub centers: Centers,
    pub left: Vec<Slot>,
    pub right: Vec<Slot>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WrongSize(pub usize);

impl fmt::Display for WrongSize {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "the analog settings are {} bytes, expected {BLOCK_SIZE}",
            self.0
        )
    }
}

impl std::error::Error for WrongSize {}

fn f32_at(b: &[u8], at: usize) -> f32 {
    b.get(at..at + 4)
        .and_then(|s| <[u8; 4]>::try_from(s).ok())
        .map_or(0.0, f32::from_le_bytes)
}

fn u16_at(b: &[u8], at: usize) -> u16 {
    b.get(at..at + 2)
        .and_then(|s| <[u8; 2]>::try_from(s).ok())
        .map_or(0, u16::from_le_bytes)
}

fn slots(b: &[u8], side: Side) -> Vec<Slot> {
    let start = slots_at(side);
    (0..SLOT_COUNT)
        .map(|i| {
            let at = start + i * SLOT_SIZE;
            Slot {
                in_angle: f32_at(b, at),
                out_angle: f32_at(b, at + 4),
                deadzone: f32_at(b, at + 8),
                in_distance: f32_at(b, at + 12),
                out_distance: f32_at(b, at + 16),
                enabled: b.get(at + 20).is_some_and(|&e| e != 0),
            }
        })
        .collect()
}

pub fn parse(b: &[u8]) -> Result<Analog, WrongSize> {
    if b.len() != BLOCK_SIZE {
        return Err(WrongSize(b.len()));
    }
    let center = |i: usize| u16_at(b, CENTERS_AT + i * 2) >> 1;
    Ok(Analog {
        version: b.first().copied().unwrap_or(0),
        calibration_set: b.get(1).is_some_and(|&c| c != 0),
        centers: Centers {
            lx: center(0),
            ly: center(1),
            rx: center(2),
            ry: center(3),
        },
        left: slots(b, Side::Left),
        right: slots(b, Side::Right),
    })
}

const fn slots_at(side: Side) -> usize {
    match side {
        Side::Left => LEFT_SLOTS_AT,
        Side::Right => RIGHT_SLOTS_AT,
    }
}

#[must_use]
pub fn read_slots(b: &[u8], side: Side) -> Vec<Slot> { slots(b, side) }

fn put(b: &mut [u8], at: usize, bytes: &[u8]) {
    if let Some(dst) = b.get_mut(at..at + bytes.len()) {
        dst.copy_from_slice(bytes);
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WriteError {
    Size(WrongSize),
    SlotCount(usize),
}

impl fmt::Display for WriteError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Size(e) => e.fmt(f),
            Self::SlotCount(n) => write!(f, "expected {SLOT_COUNT} slots, got {n}"),
        }
    }
}

impl std::error::Error for WriteError {}

pub fn write_slots(b: &[u8], side: Side, new: &[Slot]) -> Result<Vec<u8>, WriteError> {
    if b.len() != BLOCK_SIZE {
        return Err(WriteError::Size(WrongSize(b.len())));
    }
    if new.len() != SLOT_COUNT {
        return Err(WriteError::SlotCount(new.len()));
    }
    let mut out = b.to_vec();
    for (i, s) in new.iter().enumerate() {
        let at = slots_at(side) + i * SLOT_SIZE;
        put(&mut out, at, &s.in_angle.to_le_bytes());
        put(&mut out, at + 4, &s.out_angle.to_le_bytes());
        put(&mut out, at + 8, &s.deadzone.to_le_bytes());
        put(&mut out, at + 12, &s.in_distance.to_le_bytes());
        put(&mut out, at + 16, &s.out_distance.to_le_bytes());
        put(&mut out, at + 20, &[u8::from(s.enabled)]);
    }
    Ok(out)
}

pub fn with_new_centers(backup: &[u8], fresh: &[u8]) -> Result<Vec<u8>, WrongSize> {
    for b in [backup, fresh] {
        if b.len() != BLOCK_SIZE {
            return Err(WrongSize(b.len()));
        }
    }
    let mut out = backup.to_vec();
    if let (Some(dst), Some(src)) = (out.get_mut(1..LEFT_SLOTS_AT), fresh.get(1..LEFT_SLOTS_AT)) {
        dst.copy_from_slice(src);
    }
    Ok(out)
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Capture {
    pub angle: f32,
    pub distance: f32,
}

#[must_use]
pub fn parse_capture(reply: &[u8]) -> Option<Capture> {
    (reply.len() >= 12).then(|| Capture {
        angle: f32_at(reply, 4),
        distance: f32_at(reply, 8),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_block() {
        let mut b = vec![0u8; BLOCK_SIZE];
        b[0] = 0x13;
        b[1] = 1;
        b[2..4].copy_from_slice(&((2001u16 << 1) | 1).to_le_bytes());
        b[8..10].copy_from_slice(&(2004u16 << 1).to_le_bytes());
        let at = LEFT_SLOTS_AT + 3 * SLOT_SIZE;
        b[at..at + 4].copy_from_slice(&67.5f32.to_le_bytes());
        b[at + 20] = 1;
        let r = RIGHT_SLOTS_AT + 12;
        b[r..r + 4].copy_from_slice(&900f32.to_le_bytes());
        let a = parse(&b).unwrap();
        assert_eq!(
            (a.version, a.calibration_set, a.centers.lx, a.centers.ry),
            (0x13, true, 2001, 2004)
        );
        assert!(
            (a.left[3].in_angle - 67.5).abs() < f32::EPSILON
                && a.left[3].enabled
                && !a.left[4].enabled
        );
        assert!((a.right[0].in_distance - 900.0).abs() < f32::EPSILON);
        assert_eq!(parse(&b[..1000]), Err(WrongSize(1000)));
    }

    #[test]
    fn capture_reply() {
        let mut r = vec![4, 2, 3, 1];
        r.extend_from_slice(&45.5f32.to_le_bytes());
        r.extend_from_slice(&1500f32.to_le_bytes());
        assert_eq!(
            parse_capture(&r),
            Some(Capture { angle: 45.5, distance: 1500.0 })
        );
        assert_eq!(parse_capture(&r[..10]), None);
    }

    fn block() -> Vec<u8> {
        let mut b = vec![0u8; BLOCK_SIZE];
        b[0] = 0x13;
        b[1] = 1;
        b[2..4].copy_from_slice(&((2001u16 << 1) | 1).to_le_bytes());
        b[1000] = 0xab;
        b
    }

    fn slot(i: u8) -> Slot {
        Slot {
            in_angle: f32::from(i) * 22.5,
            out_angle: if i < 8 { f32::from(i) * 45.0 } else { 0.0 },
            deadzone: if i == 2 { 3.0 } else { 2.0 },
            in_distance: 1400.0 + f32::from(i),
            out_distance: if i == 1 { 2000.0 } else { 2048.0 },
            enabled: i < 10,
        }
    }

    #[test]
    fn slots_round_trip() {
        let b = block();
        let slots: Vec<Slot> = (0..16).map(slot).collect();
        let w = write_slots(&b, Side::Left, &slots).unwrap();
        let a = parse(&w).unwrap();
        assert_eq!(a.left, slots);
        assert_eq!(write_slots(&w, Side::Left, &a.left).unwrap(), w);
        assert_eq!(w[1000], 0xab);
        assert!(a.right.iter().all(|s| !s.enabled));
        assert_eq!(
            write_slots(&b, Side::Left, &slots[..7]),
            Err(WriteError::SlotCount(7))
        );
        assert_eq!(
            write_slots(&b[..10], Side::Left, &slots),
            Err(WriteError::Size(WrongSize(10)))
        );
    }

    #[test]
    fn new_centers_only() {
        let b = block();
        let mut fresh = b.clone();
        fresh[2..4].copy_from_slice(&(2040u16 << 1).to_le_bytes());
        fresh[20] = 0x77;
        let m = with_new_centers(&b, &fresh).unwrap();
        assert_eq!(parse(&m).unwrap().centers.lx, 2040);
        assert_eq!((m[20], m[1000]), (b[20], 0xab));
    }
}
