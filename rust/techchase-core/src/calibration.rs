use std::collections::VecDeque;
use std::fmt;
use std::time::Duration;

use crate::analog::{Capture, SLOT_COUNT, Slot};

pub const NOTCH_COUNT: usize = 8;
pub const MIN_NOTCH_DISTANCE: f32 = 1000.0;
pub const MAX_NOTCH_ANGLE_OFF: f32 = 20.0;
pub const STILL_FOR: Duration = Duration::from_millis(250);
pub const STILL_DEGREES: f32 = 1.0;
pub const STILL_COUNTS: f32 = 20.0;
pub const CENTER_STILL_COUNTS: f32 = 12.0;
const DEFAULT_DEADZONE: f32 = 2.0;
const DEFAULT_OUT_DISTANCE: f32 = 2048.0;
const SAME_ANGLE: f32 = 0.01;

#[must_use]
pub fn angle_off(a: f32, b: f32) -> f32 {
    let d = (a - b).rem_euclid(360.0);
    if d > 180.0 { 360.0 - d } else { d }
}

fn notch_degrees(i: usize) -> f32 { u16::try_from(i).map_or(0.0, |i| f32::from(i) * 45.0) }

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CaptureProblem {
    NoReading,
    NotAllTheWay,
    OtherNotch,
}

impl fmt::Display for CaptureProblem {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::NoReading => "no reading",
            Self::NotAllTheWay => "push the stick all the way into the notch",
            Self::OtherNotch => "that is a different notch",
        })
    }
}

#[must_use]
pub fn check_capture(i: usize, cap: Capture) -> Option<CaptureProblem> {
    if !cap.angle.is_finite() || !cap.distance.is_finite() {
        return Some(CaptureProblem::NoReading);
    }
    if cap.distance < MIN_NOTCH_DISTANCE {
        return Some(CaptureProblem::NotAllTheWay);
    }
    if angle_off(cap.angle, notch_degrees(i)) > MAX_NOTCH_ANGLE_OFF {
        return Some(CaptureProblem::OtherNotch);
    }
    None
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MissingNotches(pub usize);

impl fmt::Display for MissingNotches {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "all eight notches are needed, {} given", self.0)
    }
}

impl std::error::Error for MissingNotches {}

pub fn notch_slots(old: &[Slot], captures: &[Capture]) -> Result<Vec<Slot>, MissingNotches> {
    if captures.len() != NOTCH_COUNT {
        return Err(MissingNotches(captures.len()));
    }
    let carried =
        |out: f32| old.iter().find(|s| s.enabled && angle_off(s.out_angle, out) < SAME_ANGLE);
    Ok((0..SLOT_COUNT)
        .map(|i| match captures.get(i) {
            Some(cap) => {
                let out = notch_degrees(i);
                let prev = carried(out);
                Slot {
                    in_angle: cap.angle,
                    out_angle: out,
                    deadzone: prev.map_or(DEFAULT_DEADZONE, |s| s.deadzone),
                    in_distance: cap.distance,
                    out_distance: prev.map_or(DEFAULT_OUT_DISTANCE, |s| s.out_distance),
                    enabled: true,
                }
            }
            None => old.get(i).map_or(
                Slot {
                    in_angle: 0.0,
                    out_angle: 0.0,
                    deadzone: 0.0,
                    in_distance: 0.0,
                    out_distance: 0.0,
                    enabled: false,
                },
                |s| Slot { enabled: false, ..*s },
            ),
        })
        .collect())
}

#[must_use]
pub fn nudge(slots: &[Slot], i: usize, degrees: f32) -> Vec<Slot> {
    slots
        .iter()
        .enumerate()
        .map(|(j, s)| {
            if j == i {
                Slot {
                    in_angle: (s.in_angle + degrees).rem_euclid(360.0),
                    ..*s
                }
            } else {
                *s
            }
        })
        .collect()
}

#[derive(Debug, Clone, Copy)]
struct Sample {
    cap: Capture,
    at: Duration,
}

#[derive(Debug, Clone)]
pub struct StillDetector {
    hold: Duration,
    degrees: Option<f32>,
    counts: f32,
    samples: VecDeque<Sample>,
}

impl Default for StillDetector {
    fn default() -> Self { Self::new(STILL_FOR, Some(STILL_DEGREES), STILL_COUNTS) }
}

impl StillDetector {
    #[must_use]
    pub fn new(hold: Duration, degrees: Option<f32>, counts: f32) -> Self {
        Self {
            hold,
            degrees,
            counts,
            samples: VecDeque::new(),
        }
    }

    #[must_use]
    pub fn center() -> Self { Self::new(STILL_FOR, None, CENTER_STILL_COUNTS) }

    pub fn reset(&mut self) { self.samples.clear(); }

    pub fn feed(&mut self, cap: Capture, at: Duration) -> Option<Capture> {
        self.samples.push_back(Sample { cap, at });
        while self.samples.front().is_some_and(|s| at.saturating_sub(s.at) > self.hold * 2) {
            self.samples.pop_front();
        }
        if at.saturating_sub(self.samples.front()?.at) < self.hold {
            return None;
        }
        let span: Vec<Capture> = self
            .samples
            .iter()
            .filter(|s| at.saturating_sub(s.at) <= self.hold)
            .map(|s| s.cap)
            .collect();
        let first = span.first()?;
        let (lo, hi) = span.iter().fold((f32::INFINITY, f32::NEG_INFINITY), |(lo, hi), c| {
            (lo.min(c.distance), hi.max(c.distance))
        });
        if hi - lo > self.counts {
            return None;
        }
        if let Some(limit) = self.degrees
            && span.iter().any(|c| angle_off(c.angle, first.angle) > limit)
        {
            return None;
        }
        let (sx, sy, sd) = span.iter().fold((0.0f32, 0.0f32, 0.0f32), |(x, y, d), c| {
            let r = c.angle.to_radians();
            (x + r.cos(), y + r.sin(), d + c.distance)
        });
        let n = u16::try_from(span.len()).map_or(f32::from(u16::MAX), f32::from);
        Some(Capture {
            angle: sy.atan2(sx).to_degrees().rem_euclid(360.0),
            distance: sd / n,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cap(angle: f32, distance: f32) -> Capture { Capture { angle, distance } }

    fn ms(n: u64) -> Duration { Duration::from_millis(n) }

    fn old_slots() -> Vec<Slot> {
        (0u8..16)
            .map(|i| Slot {
                in_angle: f32::from(i) * 22.5,
                out_angle: if i < 8 { f32::from(i) * 45.0 } else { 0.0 },
                deadzone: if i == 2 { 3.0 } else { 2.0 },
                in_distance: 1400.0,
                out_distance: if i == 1 { 2000.0 } else { 2048.0 },
                enabled: i < 10,
            })
            .collect()
    }

    #[test]
    fn eight_notches_make_the_slots() {
        let caps: Vec<Capture> = (0u8..8)
            .map(|i| {
                cap(
                    (f32::from(i) * 45.0 + if i % 2 == 1 { 1.7 } else { -0.8 }).rem_euclid(360.0),
                    1500.0 + f32::from(i),
                )
            })
            .collect();
        let s = notch_slots(&old_slots(), &caps).unwrap();
        assert_eq!(s.len(), 16);
        assert!(
            s[..8]
                .iter()
                .enumerate()
                .all(|(i, s)| s.enabled && (s.out_angle - notch_degrees(i)).abs() < 1e-6)
        );
        assert!((s[0].in_angle - 359.2).abs() < 1e-3 && (s[3].in_distance - 1503.0).abs() < 1e-3);
        assert!((s[2].deadzone - 3.0).abs() < 1e-6 && (s[1].out_distance - 2000.0).abs() < 1e-6);
        assert!(s[8..].iter().all(|s| !s.enabled));
        assert_eq!(notch_slots(&old_slots(), &caps[..7]), Err(MissingNotches(7)));
    }

    #[test]
    fn captures_are_checked() {
        assert_eq!(check_capture(1, cap(47.0, 1500.0)), None);
        assert_eq!(
            check_capture(1, cap(47.0, 600.0)),
            Some(CaptureProblem::NotAllTheWay)
        );
        assert_eq!(
            check_capture(1, cap(90.0, 1500.0)),
            Some(CaptureProblem::OtherNotch)
        );
        assert_eq!(check_capture(0, cap(355.0, 1500.0)), None);
        assert_eq!(
            check_capture(0, cap(f32::NAN, 1500.0)),
            Some(CaptureProblem::NoReading)
        );
        assert!(
            (angle_off(359.0, 1.0) - 2.0).abs() < 1e-5
                && (angle_off(10.0, 350.0) - 20.0).abs() < 1e-5
        );
    }

    #[test]
    fn nudge_wraps_one_notch() {
        let s = old_slots();
        let t = nudge(&s, 0, -1.0);
        assert!((t[0].in_angle - 359.0).abs() < 1e-5);
        assert_eq!(t[1], s[1]);
    }

    #[test]
    fn a_quarter_second_still_is_held() {
        let mut d = StillDetector::default();
        assert_eq!(d.feed(cap(45.0, 1500.0), ms(0)), None);
        let mut held = None;
        for t in (10..=300).step_by(10) {
            let wobble = if t % 20 == 0 { -0.2 } else { 0.2 };
            held = held.or(d.feed(
                cap(
                    45.0 + wobble,
                    1500.0 + f32::from(u8::try_from(t % 30).unwrap()) / 10.0,
                ),
                ms(t),
            ));
        }
        let h = held.unwrap();
        assert!(angle_off(h.angle, 45.0) < 0.25 && (h.distance - 1501.0).abs() < 2.0);
    }

    #[test]
    fn a_sweep_is_never_held() {
        let mut d = StillDetector::default();
        let held = (0..=600)
            .step_by(10)
            .find_map(|t| d.feed(cap(f32::from(u16::try_from(t).unwrap()) / 10.0, 1500.0), ms(t)));
        assert_eq!(held, None);
    }

    #[test]
    fn a_hold_across_zero_averages_to_zero() {
        let mut d = StillDetector::default();
        let held = (0..=300)
            .step_by(10)
            .find_map(|t| d.feed(cap(if t % 20 == 0 { 0.2 } else { 359.8 }, 1500.0), ms(t)))
            .unwrap();
        assert!(angle_off(held.angle, 0.0) < 0.3);
    }
}
