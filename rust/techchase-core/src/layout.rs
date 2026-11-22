use std::collections::HashMap;

use crate::codes::{GcCode, InputCode};
use crate::gcu::MapEntry;

pub const MODIFIER: &str = "Power";

pub fn remappable(entries: &[MapEntry]) -> impl Iterator<Item = &MapEntry> {
    entries.iter().filter(|e| e.name != MODIFIER && e.gc_def.is_digital())
}

#[must_use]
pub fn layout_of(entries: &[MapEntry]) -> Vec<(InputCode, InputCode)> {
    let by_default: HashMap<GcCode, InputCode> =
        remappable(entries).map(|e| (e.gc_def, e.code)).collect();
    let mut out: Vec<(InputCode, InputCode)> = remappable(entries)
        .filter(|e| e.gc_cur != e.gc_def)
        .filter_map(|e| by_default.get(&e.gc_cur).map(|&t| (e.code, t)))
        .collect();
    out.sort_unstable();
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codes::SwCode;

    fn entry(code: u8, cur: i8, def: i8, name: &str) -> MapEntry {
        MapEntry {
            code: InputCode(code),
            gc_cur: GcCode(cur),
            gc_def: GcCode(def),
            sw_cur: SwCode(def),
            sw_def: SwCode(def),
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
        assert_eq!(layout_of(&entries), vec![(InputCode(10), InputCode(2))]);
        assert_eq!(remappable(&entries).count(), 3);
    }
}
