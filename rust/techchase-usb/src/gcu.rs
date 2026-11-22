use std::thread;
use std::time::{Duration, Instant};

use nusb::descriptors::TransferType;
use nusb::descriptors::language_id::US_ENGLISH;
use nusb::transfer::{Bulk, Direction, In, Out};
use nusb::{DeviceInfo, MaybeFuture};
use techchase_core::analog::{self, Analog, Capture, Cmd};
use techchase_core::codes::InputCode;
use techchase_core::gcu::{
    self, Chunk, Command, DeviceInfo as StaticInfo, Info, MapEntry, PACKET, Revert, Stats,
};

use crate::error::{Device, Result, UsbError};

const MAKER: &str = "HHL";
const STRING_TIMEOUT: Duration = Duration::from_millis(500);
const WRITE_TIMEOUT: Duration = Duration::from_secs(1);
const POLL: Duration = Duration::from_millis(300);
const REPLY_TIMEOUT: Duration = Duration::from_millis(1500);
const BLOCK_TIMEOUT: Duration = Duration::from_secs(3);
const CHUNK_TIMEOUT: Duration = Duration::from_secs(1);
const READS_IN_FLIGHT: usize = 4;
const REVERT_TRIES: usize = 25;
const REVERT_WAIT: Duration = Duration::from_millis(40);

#[derive(Debug)]
pub struct Gcu {
    pub product: String,
    pub vendor_id: u16,
    pub product_id: u16,
    out: nusb::Endpoint<Bulk, Out>,
    inp: nusb::Endpoint<Bulk, In>,
}

#[must_use]
pub fn may_be_gcu(info: &DeviceInfo) -> bool {
    gcu::VENDOR_IDS.contains(&info.vendor_id())
        && info.interfaces().any(|i| i.class() == gcu::CONFIG_CLASS)
}

fn maker(info: &DeviceInfo, device: &nusb::Device) -> Option<String> {
    if let Some(m) = info.manufacturer_string() {
        return Some(m.to_owned());
    }
    let index = device.device_descriptor().manufacturer_string_index()?;
    device.get_string_descriptor(index, US_ENGLISH, STRING_TIMEOUT).wait().ok()
}

fn config_endpoints(device: &nusb::Device) -> Option<(u8, u8, u8)> {
    let config = device.active_configuration().ok()?;
    config
        .interface_alt_settings()
        .filter(|alt| alt.class() == gcu::CONFIG_CLASS)
        .find_map(|alt| {
            let bulk = |dir| {
                alt.endpoints()
                    .find(|e| e.transfer_type() == TransferType::Bulk && e.direction() == dir)
                    .map(|e| e.address())
            };
            Some((
                alt.interface_number(),
                bulk(Direction::In)?,
                bulk(Direction::Out)?,
            ))
        })
}

impl Gcu {
    pub fn open() -> Result<Self> {
        let mut failure = UsbError::NotFound(Device::Gcu);
        for info in nusb::list_devices().wait().map_err(UsbError::List)?.filter(may_be_gcu) {
            match Self::open_info(&info) {
                Ok(gcu) => return Ok(gcu),
                Err(UsbError::NotFound(_)) => {}
                Err(e) => failure = e,
            }
        }
        Err(failure)
    }

    pub fn open_info(info: &DeviceInfo) -> Result<Self> {
        let device = info.open().wait().map_err(|e| UsbError::Open(Device::Gcu, e))?;
        if maker(info, &device).as_deref() != Some(MAKER) {
            return Err(UsbError::NotFound(Device::Gcu));
        }
        let (itf, ep_in, ep_out) = config_endpoints(&device).ok_or(UsbError::NoEndpoints)?;
        let interface = device
            .claim_interface(itf)
            .wait()
            .map_err(|e| UsbError::Claim(Device::Gcu, e))?;
        let out = interface
            .endpoint::<Bulk, Out>(ep_out)
            .map_err(|e| UsbError::Endpoint(Device::Gcu, e))?;
        let mut inp = interface
            .endpoint::<Bulk, In>(ep_in)
            .map_err(|e| UsbError::Endpoint(Device::Gcu, e))?;
        for _ in 0..READS_IN_FLIGHT {
            let buf = inp.allocate(PACKET);
            inp.submit(buf);
        }
        Ok(Self {
            product: info.product_string().unwrap_or("controller").to_owned(),
            vendor_id: info.vendor_id(),
            product_id: info.product_id(),
            out,
            inp,
        })
    }

    fn send(&mut self, packet: &[u8; PACKET]) -> Result<()> {
        let mut buf = self.out.allocate(PACKET);
        buf.extend_from_slice(packet);
        self.out
            .transfer_blocking(buf, WRITE_TIMEOUT)
            .status
            .map_err(|e| UsbError::Write(Device::Gcu, e))
    }

    fn recv_until(
        &mut self,
        until: Instant,
        want: impl Fn(&[u8]) -> bool,
    ) -> Result<Option<Vec<u8>>> {
        while Instant::now() < until {
            let Some(done) = self.inp.wait_next_complete(POLL) else {
                continue;
            };
            let status = done.status;
            let data = done.buffer.get(..done.actual_len).map_or_else(Vec::new, <[u8]>::to_vec);
            let mut buf = done.buffer;
            buf.clear();
            self.inp.submit(buf);
            status.map_err(|e| UsbError::Read(Device::Gcu, e))?;
            if !data.is_empty() && want(&data) {
                return Ok(Some(data));
            }
        }
        Ok(None)
    }

    pub fn command(&mut self, command: Command, args: &[u8]) -> Result<Vec<u8>> {
        self.send(&gcu::encode(command, args)?)?;
        self.recv_until(Instant::now() + REPLY_TIMEOUT, |p| gcu::is_reply(p, command))?
            .ok_or(UsbError::NoReply)
    }

    pub fn read_block(&mut self, read_id: u8, block: u8) -> Result<Option<Vec<u8>>> {
        self.send(&gcu::encode_block_read(read_id, block))?;
        let until = Instant::now() + BLOCK_TIMEOUT;
        let mut out = Vec::new();
        loop {
            let want = |p: &[u8]| {
                matches!(gcu::parse_block_chunk(p, read_id, block), Ok(Some(_)) | Err(_))
            };
            let Some(p) = self.recv_until(until.min(Instant::now() + CHUNK_TIMEOUT), want)? else {
                return Ok((!out.is_empty()).then_some(out));
            };
            match gcu::parse_block_chunk(&p, read_id, block)? {
                Some(Chunk::Data(d)) => out.extend_from_slice(d),
                Some(Chunk::End) => return Ok(Some(out)),
                None => {}
            }
        }
    }

    pub fn write_block(&mut self, block: u8, bytes: &[u8]) -> Result<()> {
        for packet in gcu::encode_block_write(block, bytes)? {
            self.send(&packet)?;
        }
        Ok(())
    }

    pub fn config_command(&mut self, block: u8, cmd: u8) -> Result<Vec<u8>> {
        self.send(&gcu::encode_config_command(block, cmd))?;
        let reply = self
            .recv_until(Instant::now() + REPLY_TIMEOUT, |p| {
                gcu::is_config_reply(p, block, cmd)
            })?
            .ok_or(UsbError::NoSettingsReply { block, cmd })?;
        gcu::check_config_reply(&reply, block, cmd)?;
        Ok(reply)
    }

    pub fn set_live(&mut self, mode: u8) -> Result<()> { self.send(&gcu::encode_live_mode(mode)) }

    pub fn next_packet(&mut self, timeout: Duration) -> Result<Option<Vec<u8>>> {
        self.recv_until(Instant::now() + timeout, |_| true)
    }

    pub fn device_info(&mut self) -> Result<StaticInfo> {
        Ok(gcu::parse_static_device(
            &self.read_block(gcu::ID_READ_STATIC_BLOCK, 0)?.unwrap_or_default(),
        ))
    }

    pub fn info(&mut self) -> Result<Info> { Ok(Info::parse(&self.command(Command::Info, &[])?)?) }

    pub fn stats(&mut self) -> Result<Stats> {
        Ok(Stats::parse(&self.command(Command::Stats, &[])?)?)
    }

    pub fn reset_stats(&mut self) -> Result<()> { self.command(Command::StatsReset, &[]).map(drop) }

    pub fn map(&mut self) -> Result<Vec<MapEntry>> {
        let mut entries = Vec::new();
        for page in 0..gcu::MAP_PAGES {
            let reply = self.command(Command::Map, &[page])?;
            if gcu::map_page_count(&reply)? == 0 {
                break;
            }
            entries.extend(gcu::parse_map_page(&reply, page)?);
        }
        Ok(entries)
    }

    pub fn assign(&mut self, src: InputCode, target: InputCode, save: bool) -> Result<bool> {
        let reply = self.command(Command::Assign, &gcu::assign_args(src, target, save))?;
        Ok(gcu::parse_ok(&reply, Command::Assign)?)
    }

    pub fn reset_all(&mut self, save: bool) -> Result<()> {
        self.command(Command::ResetAll, &[gcu::save_flag(save)]).map(drop)
    }

    pub fn save(&mut self) -> Result<()> {
        let reply = self.command(Command::Save, &[])?;
        if gcu::parse_ok(&reply, Command::Save)? {
            Ok(())
        } else {
            Err(UsbError::NotSaved)
        }
    }

    pub fn revert(&mut self) -> Result<()> {
        for _ in 0..REVERT_TRIES {
            match gcu::parse_revert(&self.command(Command::Revert, &[])?)? {
                Revert::Done => return Ok(()),
                Revert::NoStore => return Err(UsbError::NoStore),
                Revert::Busy | Revert::Unknown(_) => thread::sleep(REVERT_WAIT),
            }
        }
        Err(UsbError::StillSaving)
    }

    pub fn apply_layout(&mut self, pairs: &[(InputCode, InputCode)], save: bool) -> Result<()> {
        self.reset_all(save)?;
        for &(src, target) in pairs {
            if !self.assign(src, target, save)? {
                return Err(UsbError::Refused(src.0));
            }
        }
        Ok(())
    }

    pub fn analog_block(&mut self) -> Result<Vec<u8>> {
        Ok(self
            .read_block(gcu::ID_READ_CONFIG_BLOCK, analog::CFG_BLOCK)?
            .unwrap_or_default())
    }

    pub fn analog(&mut self) -> Result<Analog> { Ok(analog::parse(&self.analog_block()?)?) }

    pub fn write_analog(&mut self, block: &[u8]) -> Result<()> {
        self.write_block(analog::CFG_BLOCK, block)
    }

    pub fn capture(&mut self, cmd: Cmd) -> Result<Capture> {
        let reply = self.config_command(analog::CFG_BLOCK, cmd.code())?;
        analog::parse_capture(&reply).ok_or(UsbError::NoSettingsReply {
            block: analog::CFG_BLOCK,
            cmd: cmd.code(),
        })
    }
}

impl Drop for Gcu {
    fn drop(&mut self) { self.inp.cancel_all(); }
}
