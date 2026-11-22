const GC_NAMES: [&str; 29] = [
    "A", "B", "X", "Y", "UP", "DOWN", "LEFT", "RIGHT", "START", "Z", "L", "R", "L_ANALOG",
    "R_ANALOG", "LX_RIGHT", "LX_LEFT", "LY_UP", "LY_DOWN", "RX_RIGHT", "RX_LEFT", "RY_UP",
    "RY_DOWN", "ZL", "MINUS", "HOME", "CAPTURE", "C", "LS", "RS",
];
const GC_DIGITAL: [&str; 19] = [
    "A", "B", "X", "Y", "UP", "DOWN", "LEFT", "RIGHT", "START", "Z", "L", "R", "ZL", "MINUS",
    "HOME", "CAPTURE", "C", "LS", "RS",
];
const SW_NAMES: [&str; 30] = [
    "A",
    "B",
    "X",
    "Y",
    "UP",
    "DOWN",
    "LEFT",
    "RIGHT",
    "L",
    "R",
    "ZL",
    "ZR",
    "PLUS",
    "MINUS",
    "HOME",
    "CAPTURE",
    "LS",
    "RS",
    "LX_RIGHT",
    "LX_LEFT",
    "LY_UP",
    "LY_DOWN",
    "RX_RIGHT",
    "RX_LEFT",
    "RY_UP",
    "RY_DOWN",
    "FLICK_UP",
    "FLICK_DOWN",
    "FLICK_LEFT",
    "FLICK_RIGHT",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct InputCode(pub u8);

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct GcCode(pub i8);

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct SwCode(pub i8);

fn named(table: &'static [&'static str], code: i8) -> Option<&'static str> {
    usize::try_from(code).ok().and_then(|i| table.get(i)).copied()
}

impl InputCode {
    pub const L: Self = Self(10);
    pub const LT_ANALOG: Self = Self(11);
    pub const LX_LEFT: Self = Self(28);
    pub const LX_RIGHT: Self = Self(27);
    pub const LY_DOWN: Self = Self(30);
    pub const LY_UP: Self = Self(29);
    pub const R: Self = Self(12);
    pub const RT_ANALOG: Self = Self(13);
    pub const RX_LEFT: Self = Self(33);
    pub const RX_RIGHT: Self = Self(32);
    pub const RY_DOWN: Self = Self(35);
    pub const RY_UP: Self = Self(34);
}

impl GcCode {
    #[must_use]
    pub fn name(self) -> Option<&'static str> { named(&GC_NAMES, self.0) }

    #[must_use]
    pub fn is_digital(self) -> bool { self.name().is_some_and(|n| GC_DIGITAL.contains(&n)) }
}

impl SwCode {
    #[must_use]
    pub fn name(self) -> Option<&'static str> { named(&SW_NAMES, self.0) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names() {
        assert_eq!(GcCode(22).name(), Some("ZL"));
        assert_eq!(GcCode(-1).name(), None);
        assert_eq!(GcCode(29).name(), None);
        assert!(GcCode(9).is_digital() && !GcCode(14).is_digital());
        assert_eq!(SwCode(12).name(), Some("PLUS"));
    }
}
