use std::time::{Duration, Instant};

use nusb::MaybeFuture;
use nusb::descriptors::TransferType;
use nusb::descriptors::language_id::US_ENGLISH;
use nusb::transfer::{Bulk, Direction, In, Out};
use techchase_core::gcu::{self, Chunk, Command, PACKET};

const MAKER: &str = "HHL";
const STRING_TIMEOUT: Duration = Duration::from_millis(500);
const WRITE_TIMEOUT: Duration = Duration::from_secs(1);
const POLL: Duration = Duration::from_millis(300);
const REPLY_TIMEOUT: Duration = Duration::from_millis(1500);
const BLOCK_TIMEOUT: Duration = Duration::from_secs(3);
const READS_IN_FLIGHT: usize = 4;

pub struct Link {
    pub product: String,
    pub vendor_id: u16,
    pub product_id: u16,
    out: nusb::Endpoint<Bulk, Out>,
    inp: nusb::Endpoint<Bulk, In>,
}

fn maker(device: &nusb::Device) -> Option<String> {
    let index = device.device_descriptor().manufacturer_string_index()?;
    device
        .get_string_descriptor(index, US_ENGLISH, STRING_TIMEOUT)
        .wait()
        .ok()
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

impl Link {
    pub fn open() -> Result<Self, String> {
        let devices = nusb::list_devices()
            .wait()
            .map_err(|e| format!("listing USB devices: {e}"))?;
        let (info, device) = devices
            .filter(|d| gcu::VENDOR_IDS.contains(&d.vendor_id()))
            .filter(|d| d.interfaces().any(|i| i.class() == gcu::CONFIG_CLASS))
            .find_map(|d| {
                let device = d.open().wait().ok()?;
                (d.manufacturer_string().map(str::to_owned).or_else(|| maker(&device)).as_deref() == Some(MAKER))
                    .then_some((d, device))
            })
            .ok_or(
                "No HOJA controller with its config interface found. Plug it in over USB                  (in Slippi mode it's a plain GameCube adapter: unplug it to get back here).                  If it's plugged in, close the app's tab: only one program can use it at a time.",
            )?;
        let (itf, ep_in, ep_out) = config_endpoints(&device)
            .ok_or("the controller's config interface has no bulk endpoints")?;
        let interface = device
            .claim_interface(itf)
            .wait()
            .map_err(|e| format!("claiming the config interface: {e} (close the app's tab)"))?;
        let out = interface
            .endpoint::<Bulk, Out>(ep_out)
            .map_err(|e| format!("config OUT endpoint: {e}"))?;
        let mut inp = interface
            .endpoint::<Bulk, In>(ep_in)
            .map_err(|e| format!("config IN endpoint: {e}"))?;
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

    fn send(&mut self, packet: &[u8; PACKET]) -> Result<(), String> {
        let mut buf = self.out.allocate(PACKET);
        buf.extend_from_slice(packet);
        self.out
            .transfer_blocking(buf, WRITE_TIMEOUT)
            .status
            .map_err(|e| format!("writing to the controller: {e}"))
    }

    fn recv_until(
        &mut self,
        until: Instant,
        want: impl Fn(&[u8]) -> bool,
    ) -> Result<Option<Vec<u8>>, String> {
        while Instant::now() < until {
            let Some(done) = self.inp.wait_next_complete(POLL) else {
                continue;
            };
            let status = done.status;
            let data = done
                .buffer
                .get(..done.actual_len)
                .map_or_else(Vec::new, <[u8]>::to_vec);
            let mut buf = done.buffer;
            buf.clear();
            self.inp.submit(buf);
            status.map_err(|e| format!("reading from the controller: {e}"))?;
            if want(&data) {
                return Ok(Some(data));
            }
        }
        Ok(None)
    }

    pub fn command(&mut self, command: Command, args: &[u8]) -> Result<Vec<u8>, String> {
        self.send(&gcu::encode(command, args).map_err(|e| e.to_string())?)?;
        self.recv_until(Instant::now() + REPLY_TIMEOUT, |p| {
            gcu::is_reply(p, command)
        })?
        .ok_or_else(|| {
            "No reply to a techchase command: is the controller running the techchase firmware?"
                .to_owned()
        })
    }

    pub fn read_block(&mut self, read_id: u8, block: u8) -> Result<Option<Vec<u8>>, String> {
        self.send(&gcu::encode_block_read(read_id, block))?;
        let until = Instant::now() + BLOCK_TIMEOUT;
        let mut out = Vec::new();
        loop {
            let want = |p: &[u8]| {
                matches!(
                    gcu::parse_block_chunk(p, read_id, block),
                    Ok(Some(_)) | Err(_)
                )
            };
            let Some(p) =
                self.recv_until(until.min(Instant::now() + Duration::from_secs(1)), want)?
            else {
                return Ok((!out.is_empty()).then_some(out));
            };
            match gcu::parse_block_chunk(&p, read_id, block).map_err(|e| e.to_string())? {
                Some(Chunk::Data(d)) => out.extend_from_slice(d),
                Some(Chunk::End) => return Ok(Some(out)),
                None => {}
            }
        }
    }

    pub fn write_block(&mut self, block: u8, bytes: &[u8]) -> Result<(), String> {
        for packet in gcu::encode_block_write(block, bytes).map_err(|e| e.to_string())? {
            self.send(&packet)?;
        }
        Ok(())
    }

    pub fn config_command(&mut self, block: u8, cmd: u8) -> Result<Vec<u8>, String> {
        self.send(&gcu::encode_config_command(block, cmd))?;
        let reply = self
            .recv_until(Instant::now() + REPLY_TIMEOUT, |p| {
                gcu::is_config_reply(p, block, cmd)
            })?
            .ok_or_else(|| format!("no reply to settings command {cmd} on block {block}"))?;
        gcu::check_config_reply(&reply, block, cmd).map_err(|e| e.to_string())?;
        Ok(reply)
    }

    pub fn set_live(&mut self, mode: u8) -> Result<(), String> {
        self.send(&gcu::encode_live_mode(mode))
    }

    pub fn next_packet(&mut self, timeout: Duration) -> Result<Option<Vec<u8>>, String> {
        self.recv_until(Instant::now() + timeout, |_| true)
    }
}

impl Drop for Link {
    fn drop(&mut self) {
        self.inp.cancel_all();
    }
}
