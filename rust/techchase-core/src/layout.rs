use std::collections::HashMap;

use crate::gcu::MapEntry;

pub const GC_CODES: [&str; 29] = [
    "A", "B", "X", "Y", "UP", "DOWN", "LEFT", "RIGHT", "START", "Z", "L", "R", "L_ANALOG",
    "R_ANALOG", "LX_RIGHT", "LX_LEFT", "LY_UP", "LY_DOWN", "RX_RIGHT", "RX_LEFT", "RY_UP",
    "RY_DOWN", "ZL", "MINUS", "HOME", "CAPTURE", "C", "LS", "RS",
];
const DIGITAL: [&str; 19] = [
    "A", "B", "X", "Y", "UP", "DOWN", "LEFT", "RIGHT", "START", "Z", "L", "R", "ZL", "MINUS",
    "HOME", "CAPTURE", "C", "LS", "RS",
];
pub const MODIFIER: &str = "Power";

#[must_use]
pub fn code_name(code: i8) -> Option<&'static str> {
    usize::try_from(code)
        .ok()
        .and_then(|i| GC_CODES.get(i))
        .copied()
}

#[must_use]
pub fn is_digital(code: i8) -> bool {
    code_name(code).is_some_and(|n| DIGITAL.contains(&n))
}

pub fn remappable(entries: &[MapEntry]) -> impl Iterator<Item = &MapEntry> {
    entries
        .iter()
        .filter(|e| e.name != MODIFIER && is_digital(e.gc_def))
}

#[must_use]
pub fn layout_of(entries: &[MapEntry]) -> Vec<(u8, u8)> {
    let by_default: HashMap<i8, u8> = remappable(entries).map(|e| (e.gc_def, e.code)).collect();
    let mut out: Vec<(u8, u8)> = remappable(entries)
        .filter(|e| e.gc_cur != e.gc_def)
        .filter_map(|e| by_default.get(&e.gc_cur).map(|&t| (e.code, t)))
        .collect();
    out.sort_unstable();
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(code: u8, cur: i8, def: i8, name: &str) -> MapEntry {
        MapEntry {
            code,
            gc_cur: cur,
            gc_def: def,
            sw_cur: def,
            sw_def: def,
            name: name.to_owned(),
        }
    }

    #[test]
    fn layout_reads_swaps_only() {
        let entries = [
            entry(10, 2, 11, "ZR"),
            entry(2, 2, 2, "X"),
            entry(9, 9, 9, "Z"),
            entry(30, 0, 22, MODIFIER),
            entry(14, 14, 14, "LX"),
        ];
        assert_eq!(layout_of(&entries), vec![(10, 2)]);
        assert_eq!(remappable(&entries).count(), 3);
        assert_eq!(code_name(22), Some("ZL"));
        assert_eq!(code_name(-1), None);
        assert!(!is_digital(14));
    }
}
