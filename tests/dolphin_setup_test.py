import os
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'tools'))
import dolphin_setup as ds  # noqa: E402  tools/ is put on the path just above

DOLPHIN_INI = """[General]
ISOPath0 = x
[Core]
SIDevice0 = 6
SIDevice1 = 12
SIDevice2 = 6
[Interface]
"""

OLD_PROFILE = """[GCPad1]
Device = DInput/0/GCU 1
Buttons/A = `Button 1`
Buttons/B = `Button 2`
Buttons/X = `Button 0`
Buttons/Y = `Button 3`
Buttons/Z = `Button 7`
Buttons/Start = `Button 9`
Main Stick/Up = `Axis Y-`
Main Stick/Modifier = LSHIFT
Main Stick/Modifier/Range = 50.000000000000000
C-Stick/Up = `Axis Z-`
D-Pad/Up = `Button 12`
D-Pad/Right = `Button 13`
Buttons/Threshold = 0.0000000000000000
[GCPad2]
Device = XInput/0/Gamepad
Buttons/A = `Button A`
[GCPad3]
Device = SDL/0/GCU 1
Buttons/A = `Button 0`
"""

failures = 0


def check(ok, what):
    global failures
    print(('PASS  ' if ok else 'FAIL  ') + what)
    failures += not ok


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w', encoding='utf-8', newline='') as f:
        f.write(text.replace('\n', '\r\n'))


with tempfile.TemporaryDirectory() as root:
    user = os.path.join(root, 'slippi')
    write(os.path.join(user, 'Config', 'Dolphin.ini'), DOLPHIN_INI)
    write(os.path.join(user, 'Config', 'GCPadNew.ini'), OLD_PROFILE)
    os.makedirs(os.path.join(root, 'empty'))
    installs = ds.installs_in(root)
    ds.dolphin_running = lambda: False

    r = ds.check(installs)
    check([i['id'] for i in r['installs']] == ['slippi'], 'only folders with a Dolphin.ini count as installs')
    ports = r['installs'][0]['ports']
    check([p['si'] for p in ports] == [6, 12, 6, 0], 'port devices read, missing SIDevice3 defaults to nothing')
    p1 = ports[0]['profile']
    wrong = {w['input']: w for w in p1['wrong']}
    check(p1['checkable'] and p1['backend'] == 'DInput', 'port 1 reads the controller over DirectInput')
    check(wrong['Buttons/A']['has'] == 'Button 1' and wrong['Buttons/A']['gets'] == 'X',
          "A on Button 1 is reported as the controller's X")
    check(wrong['D-Pad/Up']['gets'] == 'L', "D-Pad Up on Button 12 is reported as the controller's L")
    check('Buttons/B' not in wrong and 'Main Stick/Up' not in wrong, 'inputs already right are not listed')
    check('Triggers/L-Analog' in wrong and wrong['Triggers/L-Analog']['has'] == 'nothing', 'missing inputs are listed')
    check('profile' not in ports[1], 'the adapter port has no profile to check')
    p3 = ports[2]['profile']
    check(p3['reads'] == 'gcu' and p3['backend'] == 'SDL' and not p3['checkable'], 'port 3 reads it through SDL, not checked')

    for bad, what in ((('slippi', 3), 'a port it reads through SDL'), (('nope', 1), 'an unknown install'),
                      (('slippi', 5), 'port 5')):
        try:
            ds.write_profile(installs, *bad)
            check(False, f'refuses {what}')
        except ValueError:
            check(True, f'refuses {what}')

    ds.dolphin_running = lambda: True
    try:
        ds.write_profile(installs, 'slippi', 1)
        check(False, 'refuses while Dolphin is open')
    except RuntimeError:
        check(True, 'refuses while Dolphin is open')
    ds.dolphin_running = lambda: False

    before = open(os.path.join(user, 'Config', 'GCPadNew.ini'), encoding='utf-8', newline='').read()
    out = ds.write_profile(installs, 'slippi', 1)
    after = open(out['path'], encoding='utf-8', newline='').read()
    check(open(out['backup'], encoding='utf-8', newline='').read() == before, 'the backup is the old file, byte for byte')
    check(ds.check(installs)['installs'][0]['ports'][0]['profile']['wrong'] == [], 'after the rewrite port 1 matches')
    check('Device = DInput/0/GCU 1\r\n' in after and 'Main Stick/Modifier = LSHIFT\r\n' in after,
          'the device line and other settings stay')
    check(after.split('[GCPad2]')[1] == before.split('[GCPad2]')[1], 'other ports are untouched')
    check('\n' not in after.replace('\r\n', ''), 'line endings stay CRLF')
    check(after.split('[GCPad2]')[0].count('Buttons/A = ') == 1, 'no key is written twice')

print('all passed' if not failures else f'{failures} FAILED')
sys.exit(1 if failures else 0)
