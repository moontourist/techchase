use std::fmt;

pub const GC_UNITS_AT_FULL: i32 = 110;
pub const FW_FULL: i32 = 2048;
pub const RADIUS: i32 = 80;
pub const DEADZONE: i32 = 23;
pub const NOTCH_MIN_RADIUS: f64 = 70.0;
pub const NOTCH_MAX_DEGREES: f64 = 12.0;
const TRIGGER_SHIFT: u32 = 4;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Default)]
pub struct FwAxis(pub i32);

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Default)]
pub struct GcAxis(pub i32);

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Default)]
pub struct MeleeAxis(pub i32);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub struct MeleeStick {
    pub x: MeleeAxis,
    pub y: MeleeAxis,
}

impl GcAxis {
    #[must_use]
    pub fn from_fw(fw: FwAxis) -> Self {
        Self((fw.0 * GC_UNITS_AT_FULL).div_euclid(FW_FULL).clamp(-128, 127))
    }
}

impl MeleeAxis {
    #[must_use]
    pub fn value(self) -> f64 { f64::from(self.0) / f64::from(RADIUS) }
}

impl fmt::Display for MeleeAxis {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let v = self.value();
        write!(f, "{}{:.4}", if v < 0.0 { '-' } else { ' ' }, v.abs())
    }
}

fn scaled_to_rim(axis: i64, r2: i64) -> i32 {
    let reach = axis.abs() * i64::from(RADIUS);
    let m = u64::try_from((reach * reach) / r2).map_or(0, u64::isqrt);
    let m = i32::try_from(m).unwrap_or(RADIUS);
    if axis < 0 { -m } else { m }
}

fn deadzoned(v: i32) -> MeleeAxis { MeleeAxis(if v.abs() < DEADZONE { 0 } else { v }) }

#[must_use]
pub fn stick(x: GcAxis, y: GcAxis) -> MeleeStick {
    let (x64, y64) = (i64::from(x.0), i64::from(y.0));
    let r2 = x64 * x64 + y64 * y64;
    let rim = i64::from(RADIUS) * i64::from(RADIUS);
    let (mx, my) = if r2 > rim {
        (scaled_to_rim(x64, r2), scaled_to_rim(y64, r2))
    } else {
        (x.0, y.0)
    };
    MeleeStick {
        x: deadzoned(mx),
        y: deadzoned(my),
    }
}

#[must_use]
pub fn trigger(fw12: u16, digital: bool) -> u8 {
    if digital {
        return u8::MAX;
    }
    u8::try_from(fw12 >> TRIGGER_SHIFT).unwrap_or(u8::MAX)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Notch {
    Right,
    UpRight,
    Up,
    UpLeft,
    Left,
    DownLeft,
    Down,
    DownRight,
}

impl Notch {
    pub const ALL: [Self; 8] = [
        Self::Right,
        Self::UpRight,
        Self::Up,
        Self::UpLeft,
        Self::Left,
        Self::DownLeft,
        Self::Down,
        Self::DownRight,
    ];

    #[must_use]
    pub const fn name(self) -> &'static str {
        match self {
            Self::Right => "Right",
            Self::UpRight => "Up-right",
            Self::Up => "Up",
            Self::UpLeft => "Up-left",
            Self::Left => "Left",
            Self::DownLeft => "Down-left",
            Self::Down => "Down",
            Self::DownRight => "Down-right",
        }
    }

    #[must_use]
    pub const fn index(self) -> u8 {
        match self {
            Self::Right => 0,
            Self::UpRight => 1,
            Self::Up => 2,
            Self::UpLeft => 3,
            Self::Left => 4,
            Self::DownLeft => 5,
            Self::Down => 6,
            Self::DownRight => 7,
        }
    }

    #[must_use]
    pub fn degrees(self) -> f64 { f64::from(self.index()) * 45.0 }

    #[must_use]
    pub const fn ideal(self) -> (i32, i32) {
        match self {
            Self::Right => (80, 0),
            Self::UpRight => (56, 56),
            Self::Up => (0, 80),
            Self::UpLeft => (-56, 56),
            Self::Left => (-80, 0),
            Self::DownLeft => (-56, -56),
            Self::Down => (0, -80),
            Self::DownRight => (56, -56),
        }
    }

    #[must_use]
    pub fn error(self, s: MeleeStick) -> i32 {
        let (ix, iy) = self.ideal();
        (s.x.0 - ix).abs().max((s.y.0 - iy).abs())
    }
}

#[must_use]
pub fn angle_off(a: f64, b: f64) -> f64 {
    let d = (a - b).rem_euclid(360.0);
    if d > 180.0 { 360.0 - d } else { d }
}

#[must_use]
pub fn nearest_notch(x: GcAxis, y: GcAxis) -> Option<Notch> {
    let (fx, fy) = (f64::from(x.0), f64::from(y.0));
    if fx.hypot(fy) < NOTCH_MIN_RADIUS {
        return None;
    }
    let deg = fy.atan2(fx).to_degrees().rem_euclid(360.0);
    Notch::ALL
        .into_iter()
        .map(|n| (n, angle_off(deg, n.degrees())))
        .filter(|&(_, d)| d <= NOTCH_MAX_DEGREES)
        .min_by(|a, b| a.1.total_cmp(&b.1))
        .map(|(n, _)| n)
}

#[cfg(test)]
mod tests {
    use super::*;

    const GTS: [(i32, i32, f64, f64); 9] = [
        (0, 102, 0.0, 1.0),
        (76, 73, 0.7125, 0.6875),
        (100, 0, 1.0, 0.0),
        (74, -75, 0.7, -0.7),
        (0, -101, 0.0, -1.0),
        (-73, -73, -0.7, -0.7),
        (-101, 0, -1.0, 0.0),
        (-74, 77, -0.6875, 0.7125),
        (0, 0, 0.0, 0.0),
    ];

    fn at(x: i32, y: i32) -> MeleeStick { stick(GcAxis(x), GcAxis(y)) }

    #[test]
    fn matches_gts_readings() {
        for (x, y, ex, ey) in GTS {
            let s = at(x, y);
            assert!(
                (s.x.value() - ex).abs() < 1e-9 && (s.y.value() - ey).abs() < 1e-9,
                "raw ({x}, {y}) should read ({ex}, {ey}), got ({}, {})",
                s.x.value(),
                s.y.value()
            );
        }
    }

    #[test]
    fn deadzone_edge() {
        assert_eq!(at(22, 0).x, MeleeAxis(0));
        assert_eq!(at(23, 0).x, MeleeAxis(23));
    }

    #[test]
    fn notches() {
        assert_eq!(nearest_notch(GcAxis(76), GcAxis(73)), Some(Notch::UpRight));
        assert_eq!(nearest_notch(GcAxis(0), GcAxis(-101)), Some(Notch::Down));
        assert_eq!(nearest_notch(GcAxis(20), GcAxis(20)), None);
        assert_eq!(nearest_notch(GcAxis(100), GcAxis(50)), None);
        assert_eq!(Notch::UpRight.error(at(76, 73)), 1);
    }

    #[test]
    fn firmware_to_gamecube() {
        assert_eq!(GcAxis::from_fw(FwAxis(2048)), GcAxis(110));
        assert_eq!(GcAxis::from_fw(FwAxis(-2048)), GcAxis(-110));
        assert_eq!(GcAxis::from_fw(FwAxis(-1)), GcAxis(-1));
        assert_eq!(GcAxis::from_fw(FwAxis(0)), GcAxis(0));
        assert_eq!(GcAxis::from_fw(FwAxis(9000)), GcAxis(127));
    }

    #[test]
    fn display_and_triggers() {
        assert_eq!(MeleeAxis(57).to_string(), " 0.7125");
        assert_eq!(MeleeAxis(-56).to_string(), "-0.7000");
        assert_eq!(trigger(4095, false), 255);
        assert_eq!(trigger(1600, false), 100);
        assert_eq!(trigger(0, true), 255);
        assert!(
            (angle_off(359.0, 1.0) - 2.0).abs() < 1e-9
                && (angle_off(10.0, 350.0) - 20.0).abs() < 1e-9
        );
    }

    #[test]
    fn rim_scaling_agrees_with_floats() {
        for x in -128..=127 {
            for y in [-128, -101, -77, -56, 0, 33, 56, 75, 101, 127] {
                let s = at(x, y);
                let (fx, fy) = (f64::from(x), f64::from(y));
                let r = fx.hypot(fy);
                let (mut ex, mut ey) = (fx, fy);
                if r > 80.0 {
                    ex = (fx * 80.0 / r).trunc();
                    ey = (fy * 80.0 / r).trunc();
                }
                let dz = |v: f64| if v.abs() < 23.0 { 0.0 } else { v };
                assert_eq!(
                    (f64::from(s.x.0), f64::from(s.y.0)),
                    (dz(ex), dz(ey)),
                    "at ({x}, {y})"
                );
            }
        }
    }
}
