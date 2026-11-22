use std::fmt;

use crate::codes::{GcCode, InputCode, SwCode};

pub const VENDOR_IDS: [u16; 2] = [0x2e8a, 0x057e];
pub const CONFIG_CLASS: u8 = 0xff;
pub const PACKET: usize = 64;
pub const ID_READ_CONFIG_BLOCK: u8 = 0x01;
pub const ID_READ_STATIC_BLOCK: u8 = 0x03;
pub const ID_TECHCHASE: u8 = 0xc0;
pub const FIRST_LIVE_REPORT: u8 = 253;
pub const LAST_CHUNK: u8 = 0xff;
pub const MAP_PAGES: u8 = 16;
const NO_SAVE: u8 = 0x01;
const MAP_ENTRY: usize = 13;
const NAME_LEN: usize = 8;
const STATS_LEN: usize = 42;
const STATIC_NAME_LEN: usize = 16;
const STATIC_FW_AT: usize = 704;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Command {
    Info,
    Stats,
    StatsReset,
    Latch,
    Assign,
    ResetAll,
    Map,
    UsbMode,
    Save,
    Revert,
}

impl Command {
    #[must_use]
    pub const fn code(self) -> u8 {
        match self {
            Self::Info => 0,
            Self::Stats => 1,
            Self::StatsReset => 2,
            Self::Latch => 3,
            Self::Assign => 4,
            Self::ResetAll => 5,
            Self::Map => 6,
            Self::UsbMode => 7,
            Self::Save => 8,
            Self::Revert => 9,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProtocolError {
    Short {
        what: &'static str,
        len: usize,
        need: usize,
    },
    NotAReply {
        what: &'static str,
    },
    MapPage {
        page: u8,
        count: u8,
    },
    Chunk {
        size: u8,
        room: usize,
    },
    TooManyArgs(usize),
    BlockTooLong(usize),
    Refused {
        block: u8,
        cmd: u8,
    },
}

impl fmt::Display for ProtocolError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Short { what, len, need } => write!(f, "{what}: {len} bytes, {need} needed"),
            Self::NotAReply { what } => write!(f, "{what}: the packet isn't that reply"),
            Self::MapPage { page, count } => {
                write!(f, "map page {page}: {count} entries don't fit in a packet")
            }
            Self::Chunk { size, room } => {
                write!(f, "a settings chunk says {size} bytes, the packet holds {room}")
            }
            Self::TooManyArgs(n) => write!(f, "{n} argument bytes don't fit in a packet"),
            Self::BlockTooLong(n) => write!(f, "a {n}-byte settings block is too long to send"),
            Self::Refused { block, cmd } => write!(
                f,
                "the controller refused settings command {cmd} on block {block}"
            ),
        }
    }
}

impl std::error::Error for ProtocolError {}

pub fn encode(command: Command, args: &[u8]) -> Result<[u8; PACKET], ProtocolError> {
    let mut out = [0u8; PACKET];
    let room = out.get_mut(2..2 + args.len()).ok_or(ProtocolError::TooManyArgs(args.len()))?;
    room.copy_from_slice(args);
    out[0] = ID_TECHCHASE;
    out[1] = command.code();
    Ok(out)
}

#[must_use]
pub fn encode_block_read(read_id: u8, block: u8) -> [u8; PACKET] {
    let mut out = [0u8; PACKET];
    out[0] = read_id;
    out[1] = block;
    out
}

#[must_use]
pub fn is_reply(packet: &[u8], command: Command) -> bool {
    matches!(packet, [ID_TECHCHASE, c, ..] if *c == command.code())
}

#[must_use]
pub fn is_live_report(packet: &[u8]) -> bool {
    packet.first().is_some_and(|&id| id >= FIRST_LIVE_REPORT)
}

fn byte(packet: &[u8], at: usize, what: &'static str) -> Result<u8, ProtocolError> {
    packet.get(at).copied().ok_or(ProtocolError::Short {
        what,
        len: packet.len(),
        need: at + 1,
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LatchMode {
    Off,
    Learning,
    Active,
    Unsteady,
    PollLocked,
    Other(u8),
}

impl LatchMode {
    #[must_use]
    pub const fn from_code(code: u8) -> Self {
        match code {
            0 => Self::Off,
            1 => Self::Learning,
            2 => Self::Active,
            3 => Self::Unsteady,
            4 => Self::PollLocked,
            other => Self::Other(other),
        }
    }

    #[must_use]
    pub const fn describe(self) -> &'static str {
        match self {
            Self::Off => "Off",
            Self::Learning => "Learning the host's timing (stock timing meanwhile)",
            Self::Active => "Late-latch active",
            Self::Unsteady => "Polls not steady (stock timing)",
            Self::PollLocked => "Poll-locked",
            Self::Other(_) => "?",
        }
    }

    #[must_use]
    pub const fn tracks_host_phase(self) -> bool { matches!(self, Self::Learning | Self::Active) }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReportFormat {
    SwitchPro,
    XInput,
    Slippi,
    GameCube,
    N64,
    Snes,
    SInput,
    Wii,
    Other(u8),
}

impl ReportFormat {
    #[must_use]
    pub const fn from_code(code: u8) -> Self {
        match code {
            0 => Self::SwitchPro,
            1 => Self::XInput,
            2 => Self::Slippi,
            3 => Self::GameCube,
            4 => Self::N64,
            5 => Self::Snes,
            6 => Self::SInput,
            7 => Self::Wii,
            other => Self::Other(other),
        }
    }

    #[must_use]
    pub const fn code(self) -> u8 {
        match self {
            Self::SwitchPro => 0,
            Self::XInput => 1,
            Self::Slippi => 2,
            Self::GameCube => 3,
            Self::N64 => 4,
            Self::Snes => 5,
            Self::SInput => 6,
            Self::Wii => 7,
            Self::Other(c) => c,
        }
    }

    #[must_use]
    pub const fn name(self) -> &'static str {
        match self {
            Self::SwitchPro => "Switch Pro",
            Self::XInput => "XInput",
            Self::Slippi => "Slippi (GC adapter)",
            Self::GameCube => "GameCube port",
            Self::N64 => "N64",
            Self::Snes => "SNES",
            Self::SInput => "SInput",
            Self::Wii => "Wii",
            Self::Other(_) => "?",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Info {
    pub proto: u8,
    pub latch_on: bool,
    pub latch_mode: LatchMode,
    pub report_format: ReportFormat,
    pub quick_remap: bool,
    pub unsaved: bool,
}

impl Info {
    pub fn parse(packet: &[u8]) -> Result<Self, ProtocolError> {
        const WHAT: &str = "INFO reply";
        if !is_reply(packet, Command::Info) {
            return Err(ProtocolError::NotAReply { what: WHAT });
        }
        let proto = byte(packet, 2, WHAT)?;
        Ok(Self {
            proto,
            latch_on: byte(packet, 3, WHAT)? != 0,
            latch_mode: LatchMode::from_code(byte(packet, 4, WHAT)?),
            report_format: ReportFormat::from_code(byte(packet, 5, WHAT)?),
            quick_remap: byte(packet, 6, WHAT)? != 0,
            unsaved: proto >= 2 && byte(packet, 7, WHAT)? != 0,
        })
    }

    #[must_use]
    pub const fn can_hold_changes(&self) -> bool { self.proto >= 2 }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Stats {
    pub version: u8,
    pub mode: LatchMode,
    pub latch_off: bool,
    pub guard_us: u16,
    pub count: u32,
    pub age_min_us: u32,
    pub age_max_us: u32,
    pub age_avg_us: u32,
    pub misses: u32,
    pub phase_us: u32,
    pub lead_us: u32,
    pub read_us: u32,
    pub read_max_us: u32,
}

fn le_u32(b: &[u8], at: usize) -> u32 {
    b.get(at..at + 4)
        .and_then(|s| <[u8; 4]>::try_from(s).ok())
        .map_or(0, u32::from_le_bytes)
}

impl Stats {
    pub fn parse(packet: &[u8]) -> Result<Self, ProtocolError> {
        const WHAT: &str = "STATS reply";
        if !is_reply(packet, Command::Stats) {
            return Err(ProtocolError::NotAReply { what: WHAT });
        }
        let body = packet.get(2..STATS_LEN).ok_or(ProtocolError::Short {
            what: WHAT,
            len: packet.len(),
            need: STATS_LEN,
        })?;
        let mode = byte(body, 1, WHAT)?;
        Ok(Self {
            version: byte(body, 0, WHAT)?,
            mode: LatchMode::from_code(mode & 0x7f),
            latch_off: mode & 0x80 != 0,
            guard_us: u16::from_le_bytes([byte(body, 2, WHAT)?, byte(body, 3, WHAT)?]),
            count: le_u32(body, 4),
            age_min_us: le_u32(body, 8),
            age_max_us: le_u32(body, 12),
            age_avg_us: le_u32(body, 16),
            misses: le_u32(body, 20),
            phase_us: le_u32(body, 24),
            lead_us: le_u32(body, 28),
            read_us: le_u32(body, 32),
            read_max_us: le_u32(body, 36),
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MapEntry {
    pub code: InputCode,
    pub gc_cur: GcCode,
    pub gc_def: GcCode,
    pub sw_cur: SwCode,
    pub sw_def: SwCode,
    pub name: String,
}

impl MapEntry {
    #[must_use]
    pub fn remapped(&self) -> bool { self.gc_cur != self.gc_def }
}

fn name(bytes: &[u8]) -> String {
    let end = bytes.iter().position(|&b| b == 0).unwrap_or(bytes.len());
    String::from_utf8_lossy(bytes.get(..end).unwrap_or_default()).into_owned()
}

pub fn parse_map_page(packet: &[u8], page: u8) -> Result<Vec<MapEntry>, ProtocolError> {
    const WHAT: &str = "MAP reply";
    if !is_reply(packet, Command::Map) {
        return Err(ProtocolError::NotAReply { what: WHAT });
    }
    let count = byte(packet, 3, WHAT)?;
    let body = packet
        .get(4..4 + usize::from(count) * MAP_ENTRY)
        .ok_or(ProtocolError::MapPage { page, count })?;
    let (entries, _) = body.as_chunks::<MAP_ENTRY>();
    Ok(entries
        .iter()
        .filter(|e| e[0] != 0xff)
        .map(
            |&[code, gc_cur, gc_def, sw_cur, sw_def, ref rest @ ..]| MapEntry {
                code: InputCode(code),
                gc_cur: GcCode(i8::from_le_bytes([gc_cur])),
                gc_def: GcCode(i8::from_le_bytes([gc_def])),
                sw_cur: SwCode(i8::from_le_bytes([sw_cur])),
                sw_def: SwCode(i8::from_le_bytes([sw_def])),
                name: name(rest.get(..NAME_LEN).unwrap_or_default()),
            },
        )
        .collect())
}

pub fn map_page_count(packet: &[u8]) -> Result<u8, ProtocolError> { byte(packet, 3, "MAP reply") }

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Chunk<'a> {
    Data(&'a [u8]),
    End,
}

pub fn parse_block_chunk(
    packet: &[u8],
    read_id: u8,
    block: u8,
) -> Result<Option<Chunk<'_>>, ProtocolError> {
    match packet {
        [id, b, size, part, data @ ..] if *id == read_id && *b == block => {
            if *part == LAST_CHUNK {
                return Ok(Some(Chunk::End));
            }
            data.get(..usize::from(*size))
                .map(|d| Some(Chunk::Data(d)))
                .ok_or(ProtocolError::Chunk { size: *size, room: data.len() })
        }
        _ => Ok(None),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeviceInfo {
    pub name: String,
    pub fw_version: Option<u32>,
}

#[must_use]
pub fn parse_static_device(block: &[u8]) -> DeviceInfo {
    DeviceInfo {
        name: name(block.get(..STATIC_NAME_LEN).unwrap_or(block)),
        fw_version: block.get(STATIC_FW_AT..STATIC_FW_AT + 4).map(|_| le_u32(block, STATIC_FW_AT)),
    }
}

#[must_use]
pub const fn save_flag(save: bool) -> u8 { if save { 0 } else { NO_SAVE } }

#[must_use]
pub const fn assign_args(src: InputCode, target: InputCode, save: bool) -> [u8; 3] {
    [src.0, target.0, save_flag(save)]
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Revert {
    Busy,
    Done,
    NoStore,
    Unknown(u8),
}

pub fn parse_revert(packet: &[u8]) -> Result<Revert, ProtocolError> {
    if !is_reply(packet, Command::Revert) {
        return Err(ProtocolError::NotAReply { what: "REVERT reply" });
    }
    Ok(match byte(packet, 2, "REVERT reply")? {
        0 => Revert::Busy,
        1 => Revert::Done,
        2 => Revert::NoStore,
        other => Revert::Unknown(other),
    })
}

pub fn parse_ok(packet: &[u8], command: Command) -> Result<bool, ProtocolError> {
    if !is_reply(packet, command) {
        return Err(ProtocolError::NotAReply { what: "reply" });
    }
    Ok(byte(packet, 2, "reply")? != 0)
}

pub const ID_WRITE_CONFIG_BLOCK: u8 = 0x02;
pub const ID_CONFIG_COMMAND: u8 = 0x04;
pub const ID_INPUT_COMMAND: u8 = 0x05;
pub const BLOCK_CHUNK: usize = 32;
pub const LIVE_TECHCHASE: u8 = 253;
pub const LIVE_RAW: u8 = 255;
pub const LIVE_PERIOD_US: u32 = 8000;
const LIVE_SEQ_AT: usize = 40;

pub fn encode_block_write(block: u8, bytes: &[u8]) -> Result<Vec<[u8; PACKET]>, ProtocolError> {
    let mut out = Vec::new();
    for (part, chunk) in bytes.chunks(BLOCK_CHUNK).enumerate() {
        let part = u8::try_from(part)
            .ok()
            .filter(|&p| p != LAST_CHUNK)
            .ok_or(ProtocolError::BlockTooLong(bytes.len()))?;
        let size =
            u8::try_from(chunk.len()).map_err(|_| ProtocolError::BlockTooLong(bytes.len()))?;
        let mut p = [0u8; PACKET];
        p[0] = ID_WRITE_CONFIG_BLOCK;
        p[1] = block;
        p[2] = size;
        p[3] = part;
        p.get_mut(4..4 + chunk.len())
            .ok_or(ProtocolError::BlockTooLong(bytes.len()))?
            .copy_from_slice(chunk);
        out.push(p);
    }
    let mut end = [0u8; PACKET];
    end[0] = ID_WRITE_CONFIG_BLOCK;
    end[1] = block;
    end[3] = LAST_CHUNK;
    out.push(end);
    Ok(out)
}

#[must_use]
pub fn encode_config_command(block: u8, cmd: u8) -> [u8; PACKET] {
    let mut p = [0u8; PACKET];
    p[0] = ID_CONFIG_COMMAND;
    p[1] = block;
    p[2] = cmd;
    p
}

#[must_use]
pub fn is_config_reply(packet: &[u8], block: u8, cmd: u8) -> bool {
    matches!(packet, [ID_CONFIG_COMMAND, b, c, ..] if *b == block && *c == cmd)
}

pub fn check_config_reply(packet: &[u8], block: u8, cmd: u8) -> Result<(), ProtocolError> {
    if !is_config_reply(packet, block, cmd) {
        return Err(ProtocolError::NotAReply { what: "settings command reply" });
    }
    if byte(packet, 3, "settings command reply")? == 0 {
        return Err(ProtocolError::Refused { block, cmd });
    }
    Ok(())
}

#[must_use]
pub fn encode_live_mode(mode: u8) -> [u8; PACKET] {
    let mut p = [0u8; PACKET];
    p[0] = ID_INPUT_COMMAND;
    p[2] = mode;
    p
}

#[must_use]
pub fn live_seq(packet: &[u8]) -> Option<u8> {
    match packet.first() {
        Some(&LIVE_TECHCHASE) => packet.get(LIVE_SEQ_AT).copied(),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn packet(bytes: &[u8]) -> [u8; PACKET] {
        let mut p = [0u8; PACKET];
        p[..bytes.len()].copy_from_slice(bytes);
        p
    }

    #[test]
    fn encodes_commands() {
        let p = encode(Command::Assign, &assign_args(InputCode(22), InputCode(1), false)).unwrap();
        assert_eq!(&p[..5], &[ID_TECHCHASE, 4, 22, 1, 1]);
        assert!(encode(Command::Info, &[0; 63]).is_err());
        assert_eq!(encode_block_read(ID_READ_STATIC_BLOCK, 0)[..2], [3, 0]);
    }

    #[test]
    fn info_reads_protocol_2() {
        let i = Info::parse(&packet(&[ID_TECHCHASE, 0, 2, 1, 2, 6, 0, 1])).unwrap();
        assert_eq!(
            (i.proto, i.latch_on, i.latch_mode, i.report_format, i.unsaved),
            (2, true, LatchMode::Active, ReportFormat::SInput, true)
        );
        assert!(i.can_hold_changes());
        let old = Info::parse(&packet(&[ID_TECHCHASE, 0, 1, 1, 2, 6, 0, 1])).unwrap();
        assert!(!old.unsaved && !old.can_hold_changes());
        assert!(Info::parse(&packet(&[ID_TECHCHASE, 1])).is_err());
        assert!(Info::parse(&[ID_TECHCHASE, 0, 2]).is_err());
    }

    #[test]
    fn stats_little_endian() {
        let mut p = packet(&[ID_TECHCHASE, 1, 1, 0x82, 0x2c, 0x01]);
        p[6..10].copy_from_slice(&1000u32.to_le_bytes());
        p[18..22].copy_from_slice(&358u32.to_le_bytes());
        let s = Stats::parse(&p).unwrap();
        assert_eq!(
            (s.mode, s.latch_off, s.guard_us, s.count, s.age_avg_us),
            (LatchMode::Active, true, 300, 1000, 358)
        );
        assert!(Stats::parse(&p[..30]).is_err());
    }

    #[test]
    fn map_pages() {
        let mut p = packet(&[ID_TECHCHASE, 6, 0, 2]);
        p[4..17].copy_from_slice(&[22, 3, 26, 0xfe, 10, b'Z', b'L', 0, 0, 0, 0, 0, 0]);
        p[17] = 0xff;
        let e = parse_map_page(&p, 0).unwrap();
        assert_eq!(e.len(), 1);
        assert_eq!(
            (
                e[0].code,
                e[0].gc_cur,
                e[0].gc_def,
                e[0].sw_cur,
                e[0].name.as_str()
            ),
            (InputCode(22), GcCode(3), GcCode(26), SwCode(-2), "ZL")
        );
        assert!(e[0].remapped());
        let mut too_many = p;
        too_many[3] = 5;
        assert_eq!(
            parse_map_page(&too_many, 3),
            Err(ProtocolError::MapPage { page: 3, count: 5 })
        );
    }

    #[test]
    fn block_chunks() {
        let p = packet(&[ID_READ_STATIC_BLOCK, 0, 3, 0, b'G', b'C', b'U']);
        assert_eq!(
            parse_block_chunk(&p, ID_READ_STATIC_BLOCK, 0),
            Ok(Some(Chunk::Data(b"GCU")))
        );
        assert_eq!(
            parse_block_chunk(&packet(&[3, 0, 0, 0xff]), 3, 0),
            Ok(Some(Chunk::End))
        );
        assert_eq!(parse_block_chunk(&p, ID_READ_STATIC_BLOCK, 1), Ok(None));
        assert!(parse_block_chunk(&packet(&[3, 0, 61, 0]), 3, 0).is_err());
    }

    #[test]
    fn static_device_block() {
        let mut b = vec![0u8; 708];
        b[..5].copy_from_slice(b"GCU 1");
        b[704..708].copy_from_slice(&1_795_303_483u32.to_le_bytes());
        let d = parse_static_device(&b);
        assert_eq!((d.name.as_str(), d.fw_version), ("GCU 1", Some(1_795_303_483)));
        assert_eq!(parse_static_device(&b[..20]).fw_version, None);
    }

    #[test]
    fn revert_and_live() {
        assert_eq!(parse_revert(&packet(&[ID_TECHCHASE, 9, 1])), Ok(Revert::Done));
        assert_eq!(
            parse_revert(&packet(&[ID_TECHCHASE, 9, 7])),
            Ok(Revert::Unknown(7))
        );
        assert!(is_live_report(&[253]) && !is_live_report(&[ID_TECHCHASE]) && !is_live_report(&[]));
        assert_eq!(parse_ok(&packet(&[ID_TECHCHASE, 8, 1]), Command::Save), Ok(true));
    }

    #[test]
    fn block_writes_and_settings_commands() {
        let bytes: Vec<u8> = (0..70).collect();
        let w = encode_block_write(2, &bytes).unwrap();
        assert_eq!(w.len(), 4);
        assert_eq!(&w[0][..5], &[ID_WRITE_CONFIG_BLOCK, 2, 32, 0, 0]);
        assert_eq!(&w[2][..5], &[ID_WRITE_CONFIG_BLOCK, 2, 6, 2, 64]);
        assert_eq!(&w[3][..4], &[ID_WRITE_CONFIG_BLOCK, 2, 0, LAST_CHUNK]);
        assert!(encode_block_write(2, &vec![0; 32 * 256]).is_err());
        assert_eq!(&encode_config_command(2, 3)[..4], &[ID_CONFIG_COMMAND, 2, 3, 0]);
        assert_eq!(
            check_config_reply(&packet(&[ID_CONFIG_COMMAND, 2, 3, 1]), 2, 3),
            Ok(())
        );
        assert_eq!(
            check_config_reply(&packet(&[ID_CONFIG_COMMAND, 2, 3, 0]), 2, 3),
            Err(ProtocolError::Refused { block: 2, cmd: 3 })
        );
        assert!(!is_config_reply(&packet(&[ID_CONFIG_COMMAND, 2, 4, 1]), 2, 3));
    }

    #[test]
    fn live_stream() {
        assert_eq!(&encode_live_mode(LIVE_TECHCHASE)[..3], &[
            ID_INPUT_COMMAND,
            0,
            253
        ]);
        let mut p = packet(&[LIVE_TECHCHASE]);
        p[40] = 77;
        assert_eq!(live_seq(&p), Some(77));
        assert_eq!(live_seq(&packet(&[254])), None);
    }
}
