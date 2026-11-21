"""Slippi-mode A/B without Dolphin: poll the controller the way Dolphin polls a GameCube adapter
(0x13 handshake, then 37-byte reads on the adapter endpoint every 1 ms frame), and read the
firmware's latency stats over the config interface from the same process. Windows lets only one
process open the adapter, so this can't run beside Dolphin.

Reads use a ring of asynchronous libusb transfers so one is always pending and the host polls every
frame, as Dolphin's adapter thread does (synchronous reads from Python turn around too slowly).

  python tools/slippi_poll_ab.py [SECONDS]      (needs: pip install libusb1 pyusb libusb-package)
"""
import ctypes
import os
import struct
import sys
import time

import libusb_package
import usb1

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import gcu  # noqa: E402  (names and stats layout)

secs = float(sys.argv[1]) if len(sys.argv) > 1 else 5.0

# libusb-package's libusb (1.0.30) has the WinUSB RAW_IO switch; python-libusb1's own DLL does not
lib_path = str(libusb_package.get_library_path())
raw = ctypes.CDLL(lib_path)
usb1.loadLibrary(raw)
ctx = usb1.USBContext()
try:
    ctx.open()  # libusb1 >= 3
except AttributeError:
    pass
# Use libusb-package's DLL when python-libusb1 has none of its own
handle = ctx.openByVendorIDAndProductID(0x057E, 0x0337)
if handle is None:
    sys.exit("No controller in Slippi mode (057e:0337). Run  gcu.py mode slippi  first, and close Dolphin.")
dev = handle.getDevice()

adapter_itf = cfg_itf = None
eps = {}
for setting in dev[0]:
    for alt in setting:
        n, cls = alt.getNumber(), alt.getClass()
        for e in alt:
            eps.setdefault(n, []).append((e.getAddress(), e.getAttributes() & 3))
        if cls == 0xFF:
            cfg_itf = n
        elif adapter_itf is None:
            adapter_itf = n
if cfg_itf is None:
    sys.exit("No config interface: switch to Slippi mode with  gcu.py mode slippi  (not from the controller).")

ad_in = next(a for a, t in eps[adapter_itf] if a & 0x80)
ad_out = next((a for a, t in eps[adapter_itf] if not a & 0x80), None)
cf_in = next(a for a, t in eps[cfg_itf] if a & 0x80)
cf_out = next(a for a, t in eps[cfg_itf] if not a & 0x80)

for i in (adapter_itf, cfg_itf):
    handle.claimInterface(i)

# WinUSB without RAW_IO hands the host controller one read at a time, so it can't poll every frame
# (about 470 reads/s at bInterval 1). RAW_IO keeps the queued reads at the controller.
raw.libusb_endpoint_set_raw_io.argtypes = [ctypes.c_void_p, ctypes.c_uint8, ctypes.c_int]
rc = raw.libusb_endpoint_set_raw_io(ctypes.cast(handle._USBDeviceHandle__handle, ctypes.c_void_p).value, ad_in, 1)
print(f"WinUSB RAW_IO on {ad_in:#x}: {'on' if rc == 0 else f'failed ({rc})'}")

if ad_out:
    handle.interruptWrite(ad_out, bytes([0x13]), timeout=500)

reads = 0


def on_done(t):
    global reads
    if t.getStatus() == usb1.TRANSFER_COMPLETED:
        reads += 1
    if running:
        t.submit()


running = True
ring = []
for _ in range(4):
    t = handle.getTransfer()
    t.setInterrupt(ad_in, 37, callback=on_done, timeout=0)
    t.submit()
    ring.append(t)


def pump(seconds):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        ctx.handleEventsTimeout(0.01)


def command(sub, *args):
    """Send a techchase command and wait for its reply while keeping the poll ring running."""
    data = bytes([gcu.ID_TECHCHASE, sub, *args])
    handle.bulkWrite(cf_out, data + bytes(64 - len(data)), timeout=1000)
    end = time.monotonic() + 1.5
    while time.monotonic() < end:
        try:
            r = handle.bulkRead(cf_in, 64, timeout=20)
        except usb1.USBErrorTimeout:
            ctx.handleEventsTimeout(0)
            continue
        if len(r) >= 2 and r[0] == gcu.ID_TECHCHASE and r[1] == sub:
            return r
    raise RuntimeError("no reply")


def stats():
    r = command(gcu.T_STATS)
    return dict(zip(gcu.STATS_KEYS, struct.unpack_from(gcu.STATS_FMT, r, 2)))


pump(1.0)
results = {}
try:
    for label, on in (('stock timing', 0), ('late-latch', 1), ('stock timing', 0), ('late-latch', 1)):
        command(gcu.T_LATCH, on)
        pump(0.7)
        command(gcu.T_STATS_RESET)
        r0 = reads
        pump(secs)
        s = stats()
        results.setdefault(label, []).append(s['age_avg_us'])
        print(f"{label:13s} avg {s['age_avg_us']:5d} us  min {s['age_min_us']:5d}  max {s['age_max_us']:5d}"
              f"  late {s['misses']:3d}  n {s['count']:5d}  reads/s {(reads - r0) / secs:5.0f}  "
              f"({gcu.LATCH_MODES.get(s['mode'] & 0x7F, '?')}, lead {s['lead_us']}, phase {s['phase_us']})")
finally:
    running = False
    for t in ring:
        try:
            t.cancel()
        except usb1.USBError:
            pass
    pump(0.2)
    try:
        command(gcu.T_LATCH, 1)
    finally:
        for i in (adapter_itf, cfg_itf):
            handle.releaseInterface(i)
        handle.close()

a, b = (sum(v) / len(v) for v in (results['stock timing'], results['late-latch']))
print(f"\ninput age in Slippi mode: {a:.0f} us -> {b:.0f} us ({a - b:.0f} us less)")
