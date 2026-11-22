use std::time::{Duration, Instant};

use nusb::transfer::{In, Interrupt, Out};
use nusb::{DeviceInfo, MaybeFuture};
use techchase_core::adapter::{self, PORTS, Port, ReportError};

use crate::error::{Device, Result, UsbError};

const INTERFACE: u8 = 0;
const EP_IN: u8 = 0x81;
const EP_OUT: u8 = 0x02;
const START_TIMEOUT: Duration = Duration::from_millis(500);
pub const DEFAULT_QUEUE: usize = 4;

#[derive(Debug)]
pub struct Adapter {
    pub product: String,
    pub maker: Option<String>,
    inp: nusb::Endpoint<Interrupt, In>,
}

#[derive(Debug, Clone)]
pub struct Reading {
    pub at: Instant,
    pub ports: std::result::Result<[Port; PORTS], ReportError>,
}

#[must_use]
pub fn is_adapter(info: &DeviceInfo) -> bool {
    info.vendor_id() == adapter::VENDOR_ID && info.product_id() == adapter::PRODUCT_ID
}

impl Adapter {
    pub fn open(queue: usize) -> Result<Self> {
        let info = nusb::list_devices()
            .wait()
            .map_err(UsbError::List)?
            .find(is_adapter)
            .ok_or(UsbError::NotFound(Device::Adapter))?;
        Self::open_info(&info, queue)
    }

    pub fn open_info(info: &DeviceInfo, queue: usize) -> Result<Self> {
        let device = info.open().wait().map_err(|e| UsbError::Open(Device::Adapter, e))?;
        let interface = device
            .claim_interface(INTERFACE)
            .wait()
            .map_err(|e| UsbError::Claim(Device::Adapter, e))?;
        let mut out = interface
            .endpoint::<Interrupt, Out>(EP_OUT)
            .map_err(|e| UsbError::Endpoint(Device::Adapter, e))?;
        let mut start = out.allocate(1);
        start.extend_from_slice(&[adapter::START_POLLING]);
        out.transfer_blocking(start, START_TIMEOUT)
            .status
            .map_err(|e| UsbError::Write(Device::Adapter, e))?;
        let mut inp = interface
            .endpoint::<Interrupt, In>(EP_IN)
            .map_err(|e| UsbError::Endpoint(Device::Adapter, e))?;
        let packet = inp.max_packet_size();
        for _ in 0..queue.max(1) {
            let buf = inp.allocate(packet);
            inp.submit(buf);
        }
        Ok(Self {
            product: info.product_string().unwrap_or("GameCube adapter").to_owned(),
            maker: info.manufacturer_string().map(str::to_owned),
            inp,
        })
    }

    pub fn read(&mut self, timeout: Duration) -> Result<Option<Reading>> {
        Ok(self.read_raw(timeout)?.map(|report| Reading {
            at: Instant::now(),
            ports: adapter::parse_report(&report),
        }))
    }

    pub fn read_raw(&mut self, timeout: Duration) -> Result<Option<Vec<u8>>> {
        let Some(done) = self.inp.wait_next_complete(timeout) else {
            return Ok(None);
        };
        let status = done.status;
        let report = done.buffer.get(..done.actual_len).unwrap_or_default().to_vec();
        let mut buf = done.buffer;
        buf.clear();
        self.inp.submit(buf);
        status.map_err(|e| UsbError::Read(Device::Adapter, e))?;
        Ok(Some(report))
    }
}

impl Drop for Adapter {
    fn drop(&mut self) { self.inp.cancel_all(); }
}
