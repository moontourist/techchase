import argparse
import ctypes
import os
import re
import sys
import time
from ctypes import wintypes

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import gcu  # noqa: E402  tools/ is put on the path just above

LIVE_TECHCHASE = 253
ID_INPUT_COMMAND = 0x05
JOY_RETURNALL = 0xFF
JOYERR_NOERROR = 0
POV_CENTERED = 0xFFFF
POV_NAMES = {0: 'hat up', 9000: 'hat right', 18000: 'hat down', 27000: 'hat left'}
STICK_CODES = set(range(26, 36)) | {11, 13}


class JOYINFOEX(ctypes.Structure):
    _fields_ = [(n, wintypes.DWORD) for n in (
        'dwSize', 'dwFlags', 'dwXpos', 'dwYpos', 'dwZpos', 'dwRpos', 'dwUpos', 'dwVpos',
        'dwButtons', 'dwButtonNumber', 'dwPOV', 'dwReserved1', 'dwReserved2')]


class JOYCAPSW(ctypes.Structure):
    _fields_ = [('wMid', wintypes.WORD), ('wPid', wintypes.WORD), ('szPname', wintypes.WCHAR * 32)] + \
        [(n, wintypes.UINT) for n in (
            'wXmin', 'wXmax', 'wYmin', 'wYmax', 'wZmin', 'wZmax', 'wNumButtons', 'wPeriodMin',
            'wPeriodMax', 'wRmin', 'wRmax', 'wUmin', 'wUmax', 'wVmin', 'wVmax', 'wCaps', 'wMaxAxes',
            'wNumAxes', 'wMaxButtons')] + \
        [('szRegKey', wintypes.WCHAR * 32), ('szOEMVxD', wintypes.WCHAR * 260)]


winmm = ctypes.WinDLL('winmm')


def find_joystick(vid, pid):
    for i in range(winmm.joyGetNumDevs()):
        caps = JOYCAPSW()
        if winmm.joyGetDevCapsW(i, ctypes.byref(caps), ctypes.sizeof(caps)) != JOYERR_NOERROR:
            continue
        if caps.wMid == vid and caps.wPid == pid:
            return i
    return None


def joystick_state(joy):
    info = JOYINFOEX(dwSize=ctypes.sizeof(JOYINFOEX), dwFlags=JOY_RETURNALL)
    if winmm.joyGetPosEx(joy, ctypes.byref(info)) != JOYERR_NOERROR:
        return None
    sent = [f'Button {b}' for b in range(32) if info.dwButtons & (1 << b)]
    if info.dwPOV != POV_CENTERED:
        sent.append(POV_NAMES.get(info.dwPOV, f'hat {info.dwPOV}'))
    return sent


def dolphin_profile(path):
    if not path or not os.path.exists(path):
        return {}, None
    text = open(path, encoding='utf-8', errors='replace').read()
    block = re.search(r'^\[GCPad1\](.*?)(?=^\[|\Z)', text, re.S | re.M)
    if not block:
        return {}, None
    device = re.search(r'^Device = (.*)$', block.group(1), re.M)
    reads = {}
    for m in re.finditer(r'^(Buttons|D-Pad|Triggers)/([\w-]+) = `([^`]+)`', block.group(1), re.M):
        reads.setdefault(m.group(3), []).append(f'{m.group(1)}/{m.group(2)}')
    return reads, device.group(1) if device else None


def live_presses(pad):
    try:
        r = bytes(pad.dev.read(pad.ep_in, 64, timeout=50))
    except Exception:
        return None
    if len(r) < 41 or r[0] != LIVE_TECHCHASE:
        return None
    return {i for i in range(36) if r[31 + (i >> 3)] & (1 << (i & 7))}


def main():
    default_ini = os.path.join(os.environ.get('APPDATA', ''), 'Slippi Launcher', 'netplay', 'User', 'Config',
                               'GCPadNew.ini')
    ap = argparse.ArgumentParser(description='Press each button: shows what Windows receives for it, and what '
                                             "a Dolphin profile's port 1 reads it as. The controller must be in SInput mode.")
    ap.add_argument('--seconds', type=float, default=60)
    ap.add_argument('--dolphin', default=default_ini, help='GCPadNew.ini to compare with')
    a = ap.parse_args()

    pad = gcu.Pad()
    names = {e['code']: e['name'] for e in gcu.read_map(pad)}
    layout = [(e['name'], gcu.code_name(gcu.GC_CODES, e['gc_cur'])) for e in gcu.read_map(pad) if e['gc_cur'] != e['gc_def']]
    vid, pid = pad.dev.idVendor, pad.dev.idProduct
    joy = find_joystick(vid, pid)
    if joy is None:
        pad.close()
        sys.exit(f'Windows lists no joystick for {vid:04x}:{pid:04x}. Is the controller in SInput mode?')
    reads, device = dolphin_profile(a.dolphin)
    print(f'controller {pad.product} {vid:04x}:{pid:04x}, Windows joystick {joy}')
    print('remapped now: ' + (', '.join(f'{s} -> {t}' for s, t in layout) or 'nothing'))
    if device:
        print(f'Dolphin port 1 reads "{device}" ({a.dolphin})')
    print(f'Press each button on its own, one at a time, for {a.seconds:.0f} s. Ctrl+C ends early.\n')

    pad.send(ID_INPUT_COMMAND, 0, LIVE_TECHCHASE)
    seen = {}
    end = time.monotonic() + a.seconds
    try:
        while time.monotonic() < end:
            presses = live_presses(pad)
            if presses is None:
                continue
            buttons = presses - STICK_CODES
            if len(buttons) != 1:
                continue
            code = next(iter(buttons))
            sent = joystick_state(joy)
            if not sent or code in seen:
                continue
            time.sleep(0.03)
            sent = joystick_state(joy) or sent
            seen[code] = sent
            dolphin = sorted({r for s in sent for r in reads.get(s, [])})
            print(f'{names.get(code, code):>8}  sends {", ".join(sent):<22}  Dolphin reads {", ".join(dolphin) or "nothing"}')
    except KeyboardInterrupt:
        pass
    finally:
        pad.close()
    print(f'\n{len(seen)} buttons checked.')


if __name__ == '__main__':
    main()
