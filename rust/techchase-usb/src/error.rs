use std::fmt;

use techchase_core::analog::WrongSize;
use techchase_core::gcu::ProtocolError;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Device {
    Gcu,
    Adapter,
}

impl Device {
    const fn name(self) -> &'static str {
        match self {
            Self::Gcu => "the controller",
            Self::Adapter => "the adapter",
        }
    }

    const fn held_by(self) -> &'static str {
        match self {
            Self::Gcu => "close the app's tab: only one program can use it at a time",
            Self::Adapter => "close Dolphin; the adapter needs the WinUSB driver",
        }
    }
}

#[derive(Debug)]
pub enum UsbError {
    List(nusb::Error),
    NotFound(Device),
    Open(Device, nusb::Error),
    Claim(Device, nusb::Error),
    NoEndpoints,
    Endpoint(Device, nusb::Error),
    Write(Device, nusb::transfer::TransferError),
    Read(Device, nusb::transfer::TransferError),
    NoReply,
    NoSettingsReply { block: u8, cmd: u8 },
    NotSaved,
    NoStore,
    StillSaving,
    Refused(u8),
    Protocol(ProtocolError),
    Analog(WrongSize),
    Watch(nusb::Error),
}

pub type Result<T, E = UsbError> = std::result::Result<T, E>;

impl fmt::Display for UsbError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::List(e) => write!(f, "listing USB devices: {e}"),
            Self::NotFound(Device::Gcu) => f.write_str(
                "No HOJA controller with its config interface found. Plug it in over USB (in Slippi mode \
                 it's a plain GameCube adapter: unplug it to get back here). If it's plugged in, close the \
                 app's tab: only one program can use it at a time.",
            ),
            Self::NotFound(Device::Adapter) => {
                f.write_str("No GameCube adapter (057e:0337) found. Is it plugged in, and in Wii U / PC mode?")
            }
            Self::Open(d, e) => write!(f, "opening {}: {e} ({})", d.name(), d.held_by()),
            Self::Claim(d, e) => write!(f, "claiming {}: {e} ({})", d.name(), d.held_by()),
            Self::NoEndpoints => f.write_str("the controller's config interface has no bulk endpoints"),
            Self::Endpoint(d, e) => write!(f, "{}'s endpoint: {e}", d.name()),
            Self::Write(d, e) => write!(f, "writing to {}: {e}", d.name()),
            Self::Read(d, e) => write!(f, "reading from {}: {e}", d.name()),
            Self::NoReply => {
                f.write_str("No reply to a techchase command: is the controller running the techchase firmware?")
            }
            Self::NoSettingsReply { block, cmd } => write!(f, "no reply to settings command {cmd} on block {block}"),
            Self::NotSaved => f.write_str("the controller did not save"),
            Self::NoStore => f.write_str("this controller can't reload its saved layout; unplug it to drop the changes"),
            Self::StillSaving => f.write_str("the controller is still writing its last save; try again"),
            Self::Refused(input) => write!(f, "the controller refused remapping input {input}"),
            Self::Protocol(e) => e.fmt(f),
            Self::Analog(e) => e.fmt(f),
            Self::Watch(e) => write!(f, "watching for USB devices: {e}"),
        }
    }
}

impl std::error::Error for UsbError {}

impl From<ProtocolError> for UsbError {
    fn from(e: ProtocolError) -> Self { Self::Protocol(e) }
}

impl From<WrongSize> for UsbError {
    fn from(e: WrongSize) -> Self { Self::Analog(e) }
}
