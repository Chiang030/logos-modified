"""Network-free verify real ERC/DRC reports and exported standard-symbol netlist."""
import json
from pathlib import Path
import sys
import xml.etree.ElementTree as ET


def require(condition: bool, message: str) -> None:
    """Keep evidence checks active when Python optimization is enabled."""
    if not condition:
        raise ValueError(message)


def validate(root: Path) -> None:
    """Validate reported checks and exact circuit connectivity without changing files."""
    erc=json.loads((root/'erc.json').read_text()); drc=json.loads((root/'drc-parity.json').read_text())
    require(not any(sheet['violations'] for sheet in erc['sheets']), 'ERC violations')
    require(not drc['violations'] and not drc['unconnected_items'] and not drc['schematic_parity'], 'DRC/parity violations')
    xml=ET.parse(root/'led.xml').getroot()
    actual={net.attrib['name'].lstrip('/'):sorted(node.attrib['ref']+'.'+node.attrib['pin'] for node in net.findall('node')) for net in xml.findall('./nets/net')}
    expected={key:sorted(value) for key,value in json.loads((root/'expected-nets.json').read_text()).items()}
    require(actual==expected, 'Exported circuit nets differ from the expected connectivity')
    diode=xml.find('./libparts/libpart[@part="LED"]')
    if diode is None:
        raise ValueError('LED library definition missing')
    require({pin.attrib['num']:pin.attrib['name'] for pin in diode.findall('./pins/pin')}=={'1':'K','2':'A'}, 'LED pin polarity mismatch')
    print(json.dumps({'passed':True,'netlist':actual,'LED_pins':{'1':'K','2':'A'},'ERC':0,'DRC':0,'unconnected':0,'parity':0,'limitations':'Default ignored checks remain; custom footprints, board-only STEP; not production certification'},indent=2))


if __name__=='__main__': validate(Path(sys.argv[1]))
