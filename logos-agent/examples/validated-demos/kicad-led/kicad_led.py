"""Generate an isolated 5 V / 330 ohm / red LED demonstration PCB with KiCad pcbnew.

Run with the system Python that provides pcbnew, not the integrations virtualenv.
No existing project is read or modified. PCB-only: no schematic/ERC claim.
"""
from pathlib import Path
import argparse
import json
import pcbnew as pcb


def point(x: float, y: float):
    return pcb.VECTOR2I(pcb.FromMM(x), pcb.FromMM(y))


def build(output: Path) -> None:
    """Create a two-layer through-hole series circuit and its explicit net manifest."""
    output.mkdir(parents=True, exist_ok=False)
    board = pcb.BOARD()
    nets = {}
    for name in ("+5V", "LED_A", "GND"):
        net = pcb.NETINFO_ITEM(board, name)
        board.Add(net)
        nets[name] = net
    specs = [
        ("J1", "5V input", [(10, 20, "+5V"), (10, 25, "GND")]),
        ("R1", "330 ohm", [(15, 20, "+5V"), (25, 20, "LED_A")]),
        ("D1", "Red LED", [(30, 20, "LED_A"), (30, 25, "GND")]),
    ]
    for reference, value, pads in specs:
        footprint = pcb.FOOTPRINT(board)
        footprint.SetReference(reference)
        footprint.SetValue(value)
        footprint.SetAttributes(pcb.FP_THROUGH_HOLE)
        footprint.Reference().SetVisible(False)
        footprint.Value().SetVisible(False)
        for index, (x, y, net) in enumerate(pads, 1):
            pad = pcb.PAD(footprint)
            pad.SetNumber(str(index))
            pad.SetAttribute(pcb.PAD_ATTRIB_PTH)
            pad.SetShape(pcb.PAD_SHAPE_CIRCLE)
            pad.SetSize(point(2.2, 2.2))
            pad.SetDrillSize(point(1, 1))
            pad.SetLayerSet(pad.PTHMask())
            pad.SetPosition(point(x, y))
            pad.SetNet(nets[net])
            footprint.Add(pad)
        board.Add(footprint)
    for x1, y1, x2, y2, net in [(10,20,15,20,"+5V"),(25,20,30,20,"LED_A"),(30,25,10,25,"GND")]:
        track = pcb.PCB_TRACK(board)
        track.SetStart(point(x1,y1)); track.SetEnd(point(x2,y2))
        track.SetWidth(pcb.FromMM(0.5)); track.SetLayer(pcb.F_Cu); track.SetNet(nets[net])
        board.Add(track)
    corners = [(5,10),(35,10),(35,30),(5,30)]
    for start, end in zip(corners, corners[1:]+corners[:1]):
        edge = pcb.PCB_SHAPE(board)
        edge.SetShape(pcb.SHAPE_T_SEGMENT); edge.SetStart(point(*start)); edge.SetEnd(point(*end))
        edge.SetLayer(pcb.Edge_Cuts); edge.SetWidth(pcb.FromMM(0.05)); board.Add(edge)
    pcb.SaveBoard(str(output / "led.kicad_pcb"), board)
    (output / "design.json").write_text(json.dumps({"voltage_V":5,"resistance_ohm":330,"assumed_led_drop_V":2,"estimated_current_mA":1000*3/330,"estimated_resistor_power_W":9/330,"board_mm":[30,20],"note":"Custom demonstrator footprints, not production-qualified. D1 pad1 anode/pad2 cathode; no schematic, ERC not performed.","nets":{"+5V":["J1.1","R1.1"],"LED_A":["R1.2","D1.1"],"GND":["D1.2","J1.2"]}},indent=2),encoding="utf-8")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path)
    build(parser.parse_args().output)
